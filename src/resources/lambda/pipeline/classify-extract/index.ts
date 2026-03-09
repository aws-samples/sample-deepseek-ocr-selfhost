import { join } from 'path';
import { Duration } from 'aws-cdk-lib';
import { Role } from 'aws-cdk-lib/aws-iam';
import { IFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getCdkConstructId } from '../../../../shared/cdk-helpers';
import { DEFAULT_PROPS } from '../../../../shared/constants';

export const createClassifyExtractLambda = (
  scope: Construct,
  env: Record<string, string>,
  role: Role,
): IFunction => {
  const constructId = getCdkConstructId({ resourceName: 'pipeline-classify', addId: true }, scope);
  return new NodejsFunction(scope, constructId, {
    ...DEFAULT_PROPS,
    role,
    runtime: Runtime.NODEJS_22_X,
    memorySize: 256,
    timeout: Duration.minutes(2),
    entry: join(__dirname, '/handler.ts'),
    environment: env,
  });
};
