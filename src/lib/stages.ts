import { StackProps, Stage } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiGatewayStack } from '../stacks/api-gateway.stack';
import { BackendAppStack } from '../stacks/backend-app.stack';
import { KmsStack } from '../stacks/kms.stack';
import { NetworkingStack } from '../stacks/networking.stack';

const REGION = process.env.CDK_DEFAULT_REGION || '';

export interface StackInputs extends StackProps {}

export class DevStage extends Stage {
  constructor(
    scope: Construct,
    id: string,
    args: StackInputs,
    props?: StackProps,
  ) {
    super(scope, id, props);

    if (!process.env.STAGE) {
      throw new Error('Missing required env vars: STAGE');
    }

    // KMS Stack
    const kmsStack = new KmsStack(this, 'DeepSeek-OCR-KMS-Stack');

    // Network Stack
    const networkingStack = new NetworkingStack(this, 'DeepSeek-OCR-Networking-Stack', {
      env: { region: REGION },
    });

    const { vpc, securityGroups } = networkingStack;

    // Backend App Stack
    const backendAppStack= new BackendAppStack(
      this,
      'DeepSeek-OCR-Backend-App-Stack',
      {
        vpc,
        securityGroups,
        env: { region: REGION },
        ...args,
      },
    );

    backendAppStack.addDependency(kmsStack);
    backendAppStack.addDependency(networkingStack);

    // const { loadBalancer } = backendAppStack;
    //
    // // Api Stack
    // const apiGatewayStack = new ApiGatewayStack(this, 'Api-Stack', {
    //   vpc,
    //   loadBalancer,
    // });
    //
    // apiGatewayStack.addDependency(kmsStack);
    // apiGatewayStack.addDependency(networkingStack);
    // apiGatewayStack.addDependency(backendAppStack);

  }
}
