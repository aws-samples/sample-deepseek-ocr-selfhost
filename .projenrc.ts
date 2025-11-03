import { awscdk, javascript } from "projen";

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.221.0",
  defaultReleaseBranch: "main",
  name: "deepseekocr",
  projenrcTs: true,
  packageManager: javascript.NodePackageManager.PNPM,
  
  description: "DeepSeek OCR Pipeline - Hybrid CDK implementation with ECS and A2I human review",
  
  deps: [
    // AWS SDK v3 for Lambda functions
    "@aws-sdk/client-ecs",
    "@aws-sdk/client-s3", 
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-sagemaker-a2i-runtime",
    "@aws-sdk/client-sfn",
    "@aws-sdk/client-ecr",
  ],
  
  devDeps: [
    "@types/aws-lambda",
    "esbuild",
  ],

  context: {
    // Enable new features
    '@aws-cdk/core:newStyleStackSynthesis': true,
    '@aws-cdk/aws-apigateway:usagePlanKeyOrderInsensitiveId': true,
    '@aws-cdk/aws-ecs:arnFormatIncludesClusterName': true,
  },

  gitignore: [
    'docker/models/',
    '*.pem',
    '.env',
    '.DS_Store',
    'cdk.out/',
    'local-docs/',
  ],
});

// Add custom tasks
project.addTask('build-docker', {
  description: 'Build DeepSeek OCR Docker image',
  exec: 'docker build -t deepseek-ocr:latest docker/',
});

project.addTask('deploy-dev', {
  description: 'Deploy to development environment', 
  exec: 'cdk deploy --profile dev --context environment=development',
});

project.addTask('deploy-prod', {
  description: 'Deploy to production environment',
  exec: 'cdk deploy --profile prod --context environment=production --require-approval never',
});

project.synth();
