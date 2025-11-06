import { Names, RemovalPolicy } from 'aws-cdk-lib';
import { IPrincipal } from 'aws-cdk-lib/aws-iam';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const getCdkConstructId = (
  { resourceName, addId = false } :
  { resourceName: string; addId?: boolean },
  scope: Construct,
) => {
  const stage = process.env.STAGE;
  const context = process.env.APP_NAME || 'deepseek-ocr';

  if (!stage) {
    throw new Error('Missing required env vars: STAGE');
  }

  const baseName = `${stage}-${context}-${resourceName}`;
  const formatted = baseName.toLowerCase();

  return addId ? `${formatted}-${Names.uniqueId(scope)}` : formatted;
};

interface PolicyConfig {
  service: string;
  operations: string[];
  resources: string[];
  principals?: IPrincipal[];
}

interface IPolicyStatementProps {
  effect: iam.Effect;
  actions: string[];
  resources: string[];
  principals?: IPrincipal[];
}

const prefixAction = (service: string, actions: string[]) => actions.map(action => `${service}:${action}`);

export const getPolicyStatement = (config: PolicyConfig) => {
  const { service, operations, resources, principals } = config;
  const actions = prefixAction(service, operations);
  const conditions: IPolicyStatementProps = {
    effect: iam.Effect.ALLOW,
    actions,
    resources,
  };

  if (principals && principals.length) {
    conditions.principals = principals;
  }

  return new iam.PolicyStatement(conditions);
};
