import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

export interface DeepSeekOcrEcsProps {
  /**
   * VPC to deploy the ECS cluster in
   */
  vpc: ec2.IVpc;
  
  /**
   * Security groups for ECS tasks and ALB
   */
  securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
  };
  
  /**
   * ECR repository for the DeepSeek OCR image
   */
  ecrRepository: ecr.IRepository;
  
  /**
   * Docker image tag to deploy
   */
  imageTag?: string;
  
  /**
   * Environment name
   */
  environment?: string;
  
  /**
   * Minimum number of instances
   */
  minCapacity?: number;
  
  /**
   * Maximum number of instances
   */
  maxCapacity?: number;
  
  /**
   * Desired number of tasks
   */
  desiredCount?: number;
}

export class DeepSeekOcrEcs extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.Ec2Service;
  public readonly taskDefinition: ecs.Ec2TaskDefinition;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly listener: elbv2.ApplicationListener;
  
  constructor(scope: Construct, id: string, props: DeepSeekOcrEcsProps) {
    super(scope, id);
    
    const {
      vpc,
      securityGroups,
      ecrRepository,
      imageTag = 'latest',
      environment = 'development',
      minCapacity = 1,
      maxCapacity = 10,
      desiredCount = 2,
    } = props;
    
    // Create ECS cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `deepseek-ocr-${environment}`,
      containerInsights: true,
    });
    
    // Create auto scaling group for g4dn.xlarge instances
    const autoScalingGroup = this.createAutoScalingGroup(vpc, minCapacity, maxCapacity);
    
    // Add capacity provider to cluster
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'CapacityProvider', {
      autoScalingGroup,
      capacityProviderName: `deepseek-ocr-cp-${environment}`,
      enableManagedTerminationProtection: false,
    });
    
    this.cluster.addAsgCapacityProvider(capacityProvider);
    
    // Create Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: securityGroups.alb,
      loadBalancerName: `deepseek-ocr-alb-${environment}`,
    });
    
    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      targetGroupName: `deepseek-ocr-tg-${environment}`,
      
      // Health check configuration
      healthCheck: {
        enabled: true,
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        port: '8000',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        timeout: Duration.seconds(10),
        interval: Duration.seconds(30),
        healthyHttpCodes: '200',
      },
      
      // Deregistration delay
      deregistrationDelay: Duration.seconds(30),
    });
    
    // Create listener
    this.listener = this.loadBalancer.addListener('Listener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });
    
    // Create task definition
    this.taskDefinition = this.createTaskDefinition(ecrRepository, imageTag);
    
    // Create ECS service
    this.service = new ecs.Ec2Service(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: `deepseek-ocr-service-${environment}`,
      desiredCount,
      
      // Capacity provider strategy
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          weight: 1,
        },
      ],
      
      // Service configuration
      enableExecuteCommand: true,
      
      // Placement constraints - ensure tasks are placed on GPU instances
      placementConstraints: [
        ecs.PlacementConstraint.memberOf('attribute:ecs.instance-type =~ g4dn.*'),
      ],
    });
    
    // Attach to target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);
    
    // Configure auto scaling
    this.configureAutoScaling(minCapacity, maxCapacity);
  }
  
  private createAutoScalingGroup(vpc: ec2.IVpc, minCapacity: number, maxCapacity: number): autoscaling.AutoScalingGroup {
    // Create launch template for g4dn.xlarge instances
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.G4DN, ec2.InstanceSize.XLARGE),
      
      // ECS-optimized AMI with GPU support
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
      
      // Security group
      securityGroup: new ec2.SecurityGroup(this, 'Ec2SecurityGroup', {
        vpc,
        description: 'Security group for ECS EC2 instances',
        allowAllOutbound: true,
      }),
      
      // User data to configure ECS agent
      userData: ec2.UserData.forLinux(),
      
      // Instance profile with ECS permissions
      role: this.createEc2Role(),
      
      // Storage configuration
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    
    // Configure user data
    launchTemplate.userData?.addCommands(
      // Configure ECS agent
      `echo ECS_CLUSTER=${this.cluster.clusterName} >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_CONTAINER_METADATA=true >> /etc/ecs/ecs.config`,
      `echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config`,
      
      // Install NVIDIA Docker runtime
      'yum update -y',
      'amazon-linux-extras install docker',
      'service docker start',
      'usermod -a -G docker ec2-user',
      
      // Install nvidia-docker2
      'distribution=$(. /etc/os-release;echo $ID$VERSION_ID)',
      'curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.repo | tee /etc/yum.repos.d/nvidia-docker.repo',
      'yum install -y nvidia-docker2',
      'pkill -SIGHUP dockerd',
      
      // Restart ECS agent
      'systemctl restart ecs',
    );
    
    // Create auto scaling group
    const asg = new autoscaling.AutoScalingGroup(this, 'AutoScalingGroup', {
      vpc,
      launchTemplate,
      minCapacity,
      maxCapacity,
      desiredCapacity: minCapacity,
      
      // Subnet configuration - use private subnets
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      
      // Health check configuration
      healthCheck: autoscaling.HealthCheck.ec2({
        grace: Duration.minutes(5),
      }),
      
      // Update policy
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        minInstancesInService: 1,
        maxBatchSize: 1,
        waitOnResourceSignals: true,
        pauseTime: Duration.minutes(10),
      }),
    });
    
    return asg;
  }
  
  private createEc2Role(): iam.Role {
    const role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for ECS EC2 instances',
    });
    
    // Add ECS permissions
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'));
    
    // Add SSM permissions for Session Manager
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    
    // Add CloudWatch permissions
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));
    
    return role;
  }
  
  private createTaskDefinition(ecrRepository: ecr.IRepository, imageTag: string): ecs.Ec2TaskDefinition {
    // Create task execution role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role for ECS task execution',
    });
    
    taskExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );
    
    // Create task role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role for ECS tasks',
    });
    
    // Add permissions for AWS services
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
        'states:SendTaskSuccess',
        'states:SendTaskFailure',
        'sagemaker-a2i-runtime:*',
      ],
      resources: ['*'],
    }));
    
    // Create task definition
    const taskDefinition = new ecs.Ec2TaskDefinition(this, 'TaskDefinition', {
      executionRole: taskExecutionRole,
      taskRole,
      networkMode: ecs.NetworkMode.BRIDGE,
    });
    
    // Create log group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/ecs/deepseek-ocr`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    
    // Add container
    const container = taskDefinition.addContainer('DeepSeekOcrContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, imageTag),
      memoryReservationMiB: 8192,
      cpu: 2048,
      
      // GPU configuration
      gpuCount: 1,
      
      // Environment variables
      environment: {
        MODEL_PATH: '/app/models/deepseek-ai/DeepSeek-OCR',
        MAX_CONCURRENCY: '50',
        GPU_MEMORY_UTILIZATION: '0.85',
        LOG_LEVEL: 'INFO',
      },
      
      // Logging
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'deepseek-ocr',
        logGroup,
      }),
      
      // Health check
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });
    
    // Add port mapping
    container.addPortMappings({
      containerPort: 8000,
      hostPort: 0, // Dynamic port mapping
      protocol: ecs.Protocol.TCP,
    });
    
    return taskDefinition;
  }
  
  private configureAutoScaling(minCapacity: number, maxCapacity: number): void {
    // Configure service auto scaling
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity,
      maxCapacity,
    });
    
    // Scale based on CPU utilization
    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
    
    // Scale based on memory utilization
    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
    
    // Scale based on request count
    scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 100,
      targetGroup: this.targetGroup,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
  }
}
