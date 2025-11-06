import { Stack, RemovalPolicy, aws_kms as kms, aws_iam as iam, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../shared/cdk-helpers';

export class KmsStack extends Stack {
  public readonly kmsKey: kms.Key;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.kmsKey = new kms.Key(this, 'AppKey', {
      alias: 'alias/deepseek-ocr',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Allow EC2 Auto Scaling to use the key for EBS volumes
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAutoScalingServiceLinkedRole',
      principals: [
        new iam.ServicePrincipal('autoscaling.amazonaws.com'),
        new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`),
      ],
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:CreateGrant',
      ],
      resources: ['*'],
    }));

    // Allow EC2 instances to use the key for EBS volumes
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEC2UseOfTheKey',
      principals: [
        new iam.ServicePrincipal('ec2.amazonaws.com'),
      ],
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:CreateGrant',
        'kms:DescribeKey',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:ViaService': [
            `ec2.${this.region}.amazonaws.com`,
          ],
        },
      },
    }));

    // Allow EBS to use the key for volume encryption
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEBSEncryption',
      principals: [
        new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
      ],
      actions: [
        'kms:*',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'kms:CallerAccount': this.account,
          'kms:ViaService': [
            `ec2.${this.region}.amazonaws.com`,
            `autoscaling.${this.region}.amazonaws.com`,
          ],
        },
      },
    }));

    // If CloudWatch Logs need the key, allow the service principal (no app roles!)
    this.kmsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogsUseOfTheKey',
      principals: [
        new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      ],
      actions: [
        'kms:Encrypt*',
        'kms:Decrypt*',
        'kms:ReEncrypt*',
        'kms:GenerateDataKey*',
        'kms:Describe*',
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
        ArnLike: {
          'aws:SourceArn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        },
      },
    }));

    const exportKmsArn = getCdkConstructId({ resourceName: 'kms-arn' }, scope);
    new CfnOutput(this, exportKmsArn, {
      value: this.kmsKey.keyArn,
      exportName: exportKmsArn,
    });
  }
}


