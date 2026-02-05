import path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { DeepSeekOcrEc2GpuConstruct } from '../constructs/deepseek-ocr-ecs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export interface StackProps {
  vpc: ec2.IVpc;
  securityGroups: {
    ecs: ec2.SecurityGroup;
    alb: ec2.SecurityGroup;
  };
}

export class EcsStack extends cdk.Stack {
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, args: StackProps) {
    super(scope, id);

    const { vpc, securityGroups } = args;

    const exportKmsArn = getCdkConstructId({ resourceName: 'kms-arn' }, scope);
    const kmsArn = Fn.importValue(exportKmsArn);
    const kmsKey = Key.fromKeyArn(this, 'StackKms', kmsArn);

    // Make sure you have the execution and/or task role objects here
    const executionRole = new iam.Role(this, 'ExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Apply grants HERE (not in KMS stack)
    kmsKey.grantEncryptDecrypt(executionRole);
    kmsKey.grantEncryptDecrypt(taskRole);

    // ECS Cluster Stack - g5.xlarge for DeepSeek-OCR-2 with BF16 support
    // Scale-to-zero enabled: min=0, max=20, desired=0
    const ecsClusterConstruct = new DeepSeekOcrEc2GpuConstruct(this, 'EcsGpuService', {
      vpc,
      securityGroups,
      minCapacity: 0, // Scale-to-zero: no minimum instances
      maxCapacity: 20, // Allow scaling up to 20 instances
      desiredCapacity: 0, // Scale-to-zero: start with 0 instances
      dockerBuildContext: path.join(__dirname, '../../docker'),
      kmsKey,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.G5, ec2.InstanceSize.XLARGE), // A10G GPU for BF16
      spotPrice: undefined,
      // Optional: Pass Golden AMI ID from CDK context
      // goldenAmiId: this.node.tryGetContext('goldenAmiId'),
    });

    this.loadBalancer = ecsClusterConstruct.loadBalancer;
  }
}
