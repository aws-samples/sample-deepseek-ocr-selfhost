import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface DeepSeekOcrEc2GpuProps {
  vpc: ec2.IVpc;
  securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
  };
  minCapacity?: number;
  maxCapacity?: number;
  desiredCapacity?: number;
  kmsKey: kms.IKey;
  accessLogsBucket?: s3.IBucket;
  instanceType?: ec2.InstanceType;
  spotPrice?: string;
  dockerBuildContext: string;
  /**
   * Optional Golden AMI ID with pre-baked model and dependencies.
   * If provided, uses this AMI instead of the default ECS GPU-optimized AMI.
   * This significantly reduces cold start time from ~25-65 min to ~5 min.
   */
  goldenAmiId?: string;
}

export class DeepSeekOcrEc2GpuConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.Ec2Service;
  public readonly taskDefinition: ecs.Ec2TaskDefinition;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly listener: elbv2.ApplicationListener;
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  public readonly dockerImageAsset: DockerImageAsset;

  constructor(scope: Construct, id: string, props: DeepSeekOcrEc2GpuProps) {
    super(scope, id);

    const {
      vpc,
      securityGroups,
      minCapacity = 0, // Scale-to-zero: start with 0 instances
      maxCapacity = 20, // Allow scaling up to 20 instances
      desiredCapacity = 0, // Scale-to-zero: start with 0 instances
      kmsKey,
      accessLogsBucket,
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.G5, ec2.InstanceSize.XLARGE), // G5 for BF16 support
      spotPrice,
      dockerBuildContext,
      goldenAmiId,
    } = props;

    // Create ECS cluster
    this.cluster = new ecs.Cluster(this, getCdkConstructId({ resourceName: 'gpu-cluster' }, this), {
      vpc,
      clusterName: getCdkConstructId({ resourceName: 'gpu-cluster' }, this),
      containerInsights: true,
    });

    // Determine which AMI to use: Golden AMI (fast cold start) or default ECS GPU AMI
    const machineImage = goldenAmiId
      ? ec2.MachineImage.genericLinux({ [this.node.tryGetContext('aws:cdk:region') || 'us-east-1']: goldenAmiId })
      : ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU);

    // Create Launch Template for GPU instances
    const launchTemplate = new ec2.LaunchTemplate(this, getCdkConstructId({ resourceName: 'gpu-launch-template' }, this), {
      instanceType,
      machineImage, // Use Golden AMI if provided, otherwise default ECS GPU AMI
      userData: ec2.UserData.forLinux(),
      securityGroup: securityGroups.ecs,
      role: this.createInstanceRole(),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(200, { // Increased to 200GB for model storage
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    // Add user data to configure the ECS agent
    launchTemplate.userData?.addCommands(
      'echo ECS_CLUSTER=' + this.cluster.clusterName + ' >> /etc/ecs/ecs.config',
      'echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config',
      'echo ECS_ENABLE_SPOT_INSTANCE_DRAINING=true >> /etc/ecs/ecs.config',
      // Install NVIDIA drivers if not present
      'yum install -y nvidia-docker2',
      'systemctl restart docker',
      // Configure GPU for container usage
      'nvidia-smi',
      // Create directory for model cache
      'mkdir -p /mnt/ecs-data/models',
      'chmod 777 /mnt/ecs-data/models',
    );

    // Create Auto Scaling Group with mixed instances strategy
    this.autoScalingGroup = new autoscaling.AutoScalingGroup(this, getCdkConstructId({ resourceName: 'gpu-asg' }, this), {
      vpc,
      minCapacity,
      maxCapacity,
      desiredCapacity,
      launchTemplate,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });

    // Configure mixed instances for cost optimization (on-demand + spot)
    if (spotPrice) {
      const cfnAutoScalingGroup = this.autoScalingGroup.node.defaultChild as autoscaling.CfnAutoScalingGroup;
      cfnAutoScalingGroup.mixedInstancesPolicy = {
        instancesDistribution: {
          onDemandBaseCapacity: 1, // Keep at least 1 on-demand instance
          onDemandPercentageAboveBaseCapacity: 0, // Use spot for additional capacity
          spotInstancePools: 2,
          spotMaxPrice: spotPrice,
        },
        launchTemplate: {
          launchTemplateSpecification: {
            launchTemplateId: launchTemplate.launchTemplateId,
            version: '$Latest',
          },
          overrides: [
            { instanceType: 'g5.xlarge' }, // Primary: A10G GPU with BF16 support
            { instanceType: 'g5.2xlarge' }, // Fallback: Larger A10G instance
          ],
        },
      };
    }

    // Add capacity provider to cluster
    const capacityProvider = new ecs.AsgCapacityProvider(this, getCdkConstructId({ resourceName: 'gpu-capacity-provider' }, this), {
      autoScalingGroup: this.autoScalingGroup,
      enableManagedScaling: true,
      enableManagedTerminationProtection: false,
      targetCapacityPercent: 100,
      minimumScalingStepSize: 1,
      maximumScalingStepSize: 1,
    });

    this.cluster.addAsgCapacityProvider(capacityProvider);

    // Create Application Load Balancer
    const logsBucket = accessLogsBucket || new s3.Bucket(this, getCdkConstructId({ resourceName: 'alb-logs-bucket' }, this), {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{
        expiration: Duration.days(90),
      }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, getCdkConstructId({ resourceName: 'load-balancer' }, this), {
      vpc,
      internetFacing: true,
      securityGroup: securityGroups.alb,
      loadBalancerName: getCdkConstructId({ resourceName: 'gpu-lb' }, this),
      deletionProtection: false,
      dropInvalidHeaderFields: true,
    });

    this.loadBalancer.logAccessLogs(logsBucket, 'alb-access-logs');
    this.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');

    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, getCdkConstructId({ resourceName: 'target-group' }, this), {
      vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE, // Use INSTANCE for EC2
      targetGroupName: getCdkConstructId({ resourceName: 'gpu-tg' }, this),
      healthCheck: {
        enabled: true,
        path: '/health',
        protocol: elbv2.Protocol.HTTP,
        port: '8000',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        timeout: Duration.seconds(30), // Longer timeout for GPU model loading
        interval: Duration.seconds(60),
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(60),
      stickinessCookieDuration: Duration.hours(1), // Enable session stickiness
    });

    // Create listener
    this.listener = this.loadBalancer.addListener(getCdkConstructId({ resourceName: 'listener' }, this), {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [this.targetGroup],
    });

    this.dockerImageAsset = new DockerImageAsset(this, getCdkConstructId({ resourceName: 'docker-image' }, this), {
      directory: dockerBuildContext,
      file: 'Dockerfile',
      platform: Platform.LINUX_AMD64,
      exclude: [
        'node_modules',
        'cdk.out',
        '.git',
        '*.md',
        '.env',
        '.env.*',
        'README.md',
        '.gitignore',
        '.dockerignore',
        'outputs/**',
      ],
      invalidation: {
        buildArgs: false,
      },
    });

    // Create task definition
    this.taskDefinition = this.createTaskDefinition(
      this.dockerImageAsset.imageUri,
      kmsKey,
    );

    // Create ECS service
    this.service = new ecs.Ec2Service(this, getCdkConstructId({ resourceName: 'gpu-service' }, this), {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: getCdkConstructId({ resourceName: 'gpu-service' }, this),
      desiredCount: desiredCapacity,
      enableExecuteCommand: true,
      capacityProviderStrategies: [
        {
          capacityProvider: capacityProvider.capacityProviderName,
          weight: 1,
          base: 1, // Always keep at least 1 task running
        },
      ],
      placementStrategies: [
        ecs.PlacementStrategy.spreadAcrossInstances(),
      ],
      placementConstraints: [
        ecs.PlacementConstraint.memberOf('attribute:ecs.instance-type =~ g5.*'),
      ],
    });

    // Note: deploymentConfiguration is not available for EC2 services in CDK
    // To prevent GPU resource contention during deployments:
    // 1. Manually stop old tasks before deploying (as we did today)
    // 2. Use the deployment script with force deployment
    // 3. Consider using Fargate with GPU support when available
    // 4. Or add a second GPU instance during deployments, then scale back

    // Register service with target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Configure auto scaling for the service
    this.configureServiceAutoScaling(minCapacity, maxCapacity);
  }

  private createInstanceRole(): iam.Role {
    const role = new iam.Role(this, getCdkConstructId({ resourceName: 'instance-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    // Add permissions for GPU monitoring
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudwatch:PutMetricData',
        'ec2:DescribeVolumes',
        'ec2:DescribeTags',
        'logs:PutLogEvents',
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
      ],
      resources: ['*'],
    }));

    return role;
  }

  private createTaskDefinition(
    imageUri: string,
    kmsKey: kms.IKey,
  ): ecs.Ec2TaskDefinition {
    // Create task execution role
    const taskExecutionRole = new iam.Role(this, getCdkConstructId({ resourceName: 'execution-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Add ECR permissions
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // Add KMS permissions for logs
    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:GenerateDataKey',
      ],
      resources: [kmsKey.keyArn],
    }));

    // Create task role
    const taskRole = new iam.Role(this, getCdkConstructId({ resourceName: 'task-role' }, this), {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add permissions for S3 (for model storage)
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
      ],
      resources: [
        'arn:aws:s3:::*-deepseek-ocr-models/*',
        'arn:aws:s3:::*-deepseek-ocr-models',
      ],
    }));

    // Create EC2 task definition with GPU support
    const taskDefinition = new ecs.Ec2TaskDefinition(this, getCdkConstructId({ resourceName: 'gpu-task-definition' }, this), {
      executionRole: taskExecutionRole,
      taskRole,
      networkMode: ecs.NetworkMode.BRIDGE,
    });

    // Create log group
    const logGroup = new logs.LogGroup(this, getCdkConstructId({ resourceName: 'log-group' }, this), {
      logGroupName: '/aws/ecs/deepseek-ocr-gpu',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
      encryptionKey: kmsKey,
    });

    // Determine which image to use
    const containerImage = ecs.ContainerImage.fromRegistry(imageUri);

    // Create secrets for sensitive environment variables
    const secretsManager = new secretsmanager.Secret(this, getCdkConstructId({ resourceName: 'env-secrets' }, this), {
      description: 'Environment secrets for DeepSeek OCR GPU container',
      encryptionKey: kmsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          HUGGINGFACE_TOKEN: '', // Add your HuggingFace token if model is private
        }),
        generateStringKey: 'api_key',
      },
    });

    // Add container with GPU support
    const container = taskDefinition.addContainer(getCdkConstructId({ resourceName: 'gpu-container' }, this), {
      image: containerImage,

      // Allocate significant resources for the GPU model
      memoryReservationMiB: 14336, // 14GB (leaving 2GB for system on g4dn.xlarge with 16GB)
      cpu: 3840, // 3.75 vCPU (leaving 0.25 for system on 4 vCPU instance)

      // GPU configuration
      gpuCount: 1, // Request 1 GPU

      // Environment variables - DeepSeek-OCR with BF16 on g5.xlarge
      environment: {
        // GPU settings
        CUDA_VISIBLE_DEVICES: '0',

        // DeepSeek-OCR model configuration
        MODEL_PATH: 'deepseek-ai/DeepSeek-OCR', // HuggingFace repo ID
        VLLM_TORCH_DTYPE: 'bfloat16', // BF16 for A10G GPU (g5 instances)

        // Model caching directories - check Golden AMI cache first
        HF_HOME: '/app/models',
        TRANSFORMERS_CACHE: '/app/models',
        HUGGINGFACE_HUB_CACHE: '/app/models',

        // Performance settings
        MAX_CONCURRENCY: '5',
        GPU_MEMORY_UTILIZATION: '0.85',
        VLLM_USE_V1: '0',
        LOG_LEVEL: 'INFO',

        // Golden AMI model cache location (pre-downloaded model)
        MODEL_CACHE_DIR: '/mnt/ecs-data/models',

        // Optional: S3 backup for model cache
        S3_MODEL_BUCKET: `${this.node.tryGetContext('environment')}-deepseek-ocr-models`,
      },

      // Secrets (only if model is private)
      secrets: {
        // HUGGINGFACE_TOKEN: ecs.Secret.fromSecretsManager(secretsManager, 'HUGGINGFACE_TOKEN'),
      },

      // Logging
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'deepseek-ocr-gpu',
        logGroup,
      }),

      // Health check with longer timeout for model download
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/health || exit 1'],
        interval: Duration.seconds(60),
        timeout: Duration.seconds(30),
        retries: 10, // Increased retries
        startPeriod: Duration.seconds(300), // 10 minutes for initial model download
      },

      essential: true,
      stopTimeout: Duration.seconds(120),
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: 8000,
      hostPort: 8000,
      protocol: ecs.Protocol.TCP,
    });

    // Add ulimits for better GPU performance
    container.addUlimits({
      name: ecs.UlimitName.MEMLOCK,
      softLimit: -1,
      hardLimit: -1,
    });

    // Add mount points for model cache persistence (using host volume)
    container.addMountPoints({
      containerPath: '/app/models',
      sourceVolume: 'model-cache',
      readOnly: false,
    });

    // Add host volume for model cache
    taskDefinition.addVolume({
      name: 'model-cache',
      host: {
        sourcePath: '/mnt/ecs-data/models',
      },
    });

    return taskDefinition;
  }

  private configureServiceAutoScaling(minCapacity: number, maxCapacity: number): void {
    // Configure service auto scaling
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity,
      maxCapacity,
    });

    // Scale based on custom CloudWatch metric (GPU utilization)
    scalableTarget.scaleOnMetric('GpuUtilization', {
      metric: this.targetGroup.metricRequestCount({
        period: Duration.minutes(1),
        statistic: 'sum',
      }),
      scalingSteps: [
        { upper: 10, change: -1 },
        { lower: 50, change: +1 },
        { lower: 100, change: +2 },
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(5),
    });

    // Scale based on ALB request count
    scalableTarget.scaleOnRequestCount('RequestScaling', {
      requestsPerTarget: 100,
      targetGroup: this.targetGroup,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(2),
    });
  }
}
