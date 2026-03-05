import { join } from 'path';
import { Duration } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Role } from 'aws-cdk-lib/aws-iam';
import { IFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../../../../shared/cdk-helpers';
import { DEFAULT_PROPS } from '../../../../shared/constants';

export const createOcrPageLambda = (
  scope: Construct,
  env: Record<string, string>,
  role: Role,
  vpc: IVpc,
  securityGroup: SecurityGroup | ISecurityGroup,
): IFunction => {
  const constructId = getCdkConstructId({ resourceName: 'pipeline-ocr-page', addId: true }, scope);
  return new NodejsFunction(scope, constructId, {
    ...DEFAULT_PROPS,
    role,
    vpc,
    securityGroups: [securityGroup],
    runtime: Runtime.NODEJS_22_X,
    memorySize: 512,
    timeout: Duration.minutes(5),
    entry: join(__dirname, '/handler.ts'),
    environment: env,
    bundling: {
      nodeModules: ['axios', 'form-data'],
    },
  });
};
