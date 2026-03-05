import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IKey } from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import {
  createClassifyExtractLambda,
  createOcrPageLambda,
  createSaveResultsLambda,
  createStartPipelineLambda,
} from '../resources/lambda/pipeline';
import { createDefaultLambdaRole, getCdkConstructId, getPolicyStatement } from '../shared/cdk-helpers';

export interface PipelineStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  kmsKey: IKey;
  fileBucketName: string;
  securityGroup: ec2.SecurityGroup | ec2.ISecurityGroup;
  loadBalancerUrl: string;
}

export class PipelineStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;
  public readonly startPipelineLambda: IFunction;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id);

    const { vpc, kmsKey, fileBucketName, securityGroup, loadBalancerUrl } = props;

    // ========== IAM Roles ==========

    // Role for Docker Lambdas (split-pdf, pdf-to-image, excel-to-text)
    const dockerLambdaRole = createDefaultLambdaRole(
      this,
      getCdkConstructId({ resourceName: 'pipeline-docker-role' }, scope),
    );
    dockerLambdaRole.addToPolicy(getPolicyStatement({
      service: 's3',
      operations: ['GetObject', 'PutObject', 'ListBucket'],
      resources: [
        `arn:aws:s3:::${fileBucketName}`,
        `arn:aws:s3:::${fileBucketName}/*`,
      ],
    }));
    dockerLambdaRole.addToPolicy(getPolicyStatement({
      service: 'kms',
      operations: ['Encrypt', 'Decrypt', 'GenerateDataKey'],
      resources: [kmsKey.keyArn],
    }));

    // Role for OCR page Lambda (VPC-attached, needs ALB access)
    const ocrPageRole = createDefaultLambdaRole(
      this,
      getCdkConstructId({ resourceName: 'pipeline-ocr-role' }, scope),
    );
    ocrPageRole.addToPolicy(getPolicyStatement({
      service: 's3',
      operations: ['GetObject'],
      resources: [`arn:aws:s3:::${fileBucketName}/*`],
    }));
    ocrPageRole.addToPolicy(getPolicyStatement({
      service: 'kms',
      operations: ['Decrypt', 'GenerateDataKey'],
      resources: [kmsKey.keyArn],
    }));

    // Role for classify-extract Lambda (Bedrock access, no VPC)
    const classifyRole = createDefaultLambdaRole(
      this,
      getCdkConstructId({ resourceName: 'pipeline-classify-role' }, scope),
    );
    classifyRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${cdk.Stack.of(this).account}:inference-profile/*`,
      ],
    }));

    // Role for save-results Lambda (S3 write access)
    const saveResultsRole = createDefaultLambdaRole(
      this,
      getCdkConstructId({ resourceName: 'pipeline-save-role' }, scope),
    );
    saveResultsRole.addToPolicy(getPolicyStatement({
      service: 's3',
      operations: ['GetObject', 'PutObject'],
      resources: [`arn:aws:s3:::${fileBucketName}/*`],
    }));
    saveResultsRole.addToPolicy(getPolicyStatement({
      service: 'kms',
      operations: ['Encrypt', 'Decrypt', 'GenerateDataKey'],
      resources: [kmsKey.keyArn],
    }));

    // Role for start-pipeline Lambda (Step Functions access)
    const startPipelineRole = createDefaultLambdaRole(
      this,
      getCdkConstructId({ resourceName: 'pipeline-start-role' }, scope),
    );

    // ========== Docker Lambdas ==========

    const splitPdfFn = new lambda.DockerImageFunction(
      this,
      getCdkConstructId({ resourceName: 'split-pdf-fn' }, scope),
      {
        functionName: getCdkConstructId({ resourceName: 'split-pdf' }, this),
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, '../resources/lambda/split-pdf'),
          { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
        ),
        architecture: lambda.Architecture.X86_64,
        role: dockerLambdaRole,
        memorySize: 1024,
        timeout: Duration.minutes(5),
        environment: {
          FILES_BUCKET: fileBucketName,
          REGION: this.region,
        },
      },
    );

    const pdfToImageFn = new lambda.DockerImageFunction(
      this,
      getCdkConstructId({ resourceName: 'pdf-to-image-fn' }, scope),
      {
        functionName: getCdkConstructId({ resourceName: 'pdf-to-image' }, this),
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, '../resources/lambda/pdf-to-image'),
          { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
        ),
        architecture: lambda.Architecture.X86_64,
        role: dockerLambdaRole,
        memorySize: 1024,
        timeout: Duration.minutes(5),
        environment: {
          FILES_BUCKET: fileBucketName,
          REGION: this.region,
        },
      },
    );

    const excelToTextFn = new lambda.DockerImageFunction(
      this,
      getCdkConstructId({ resourceName: 'excel-to-text-fn' }, scope),
      {
        functionName: getCdkConstructId({ resourceName: 'excel-to-text' }, this),
        code: lambda.DockerImageCode.fromImageAsset(
          path.join(__dirname, '../resources/lambda/excel-to-text'),
          { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
        ),
        architecture: lambda.Architecture.X86_64,
        role: dockerLambdaRole,
        memorySize: 1024,
        timeout: Duration.minutes(5),
        environment: {
          FILES_BUCKET: fileBucketName,
          REGION: this.region,
        },
      },
    );

    // ========== TypeScript Lambdas ==========

    const ocrPageFn = createOcrPageLambda(
      this,
      {
        REGION: this.region,
        FILES_BUCKET: fileBucketName,
        ALB_URL: loadBalancerUrl,
      },
      ocrPageRole,
      vpc,
      securityGroup,
    );

    const classifyExtractFn = createClassifyExtractLambda(
      this,
      { REGION: this.region },
      classifyRole,
    );

    const saveResultsFn = createSaveResultsLambda(
      this,
      {
        REGION: this.region,
        FILES_BUCKET: fileBucketName,
      },
      saveResultsRole,
    );

    // ========== Step Functions State Machine ==========

    // Log group for state machine execution logs
    const sfnLogGroup = new logs.LogGroup(
      this,
      getCdkConstructId({ resourceName: 'pipeline-sfn-logs' }, scope),
      {
        logGroupName: `/aws/stepfunctions/deepseek-ocr-pipeline-${process.env.STAGE}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    // ---- PDF Path ----

    // Split PDF into single pages
    const splitPdfTask = new tasks.LambdaInvoke(this, 'SplitPdf', {
      lambdaFunction: splitPdfFn,
      resultPath: '$.splitResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    splitPdfTask.addRetry({
      maxAttempts: 3,
      interval: Duration.seconds(30),
      backoffRate: 2,
    });

    // Convert single-page PDF to JPEG
    const convertToImageTask = new tasks.LambdaInvoke(this, 'ConvertToImage', {
      lambdaFunction: pdfToImageFn,
      resultPath: '$.convertResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });

    // OCR the JPEG via DeepSeek ALB
    const ocrPageTask = new tasks.LambdaInvoke(this, 'OcrPage', {
      lambdaFunction: ocrPageFn,
      payload: sfn.TaskInput.fromObject({
        'imageKey.$': '$.convertResult.Payload.imageKey',
        'imageBucket.$': '$.convertResult.Payload.imageBucket',
        'pageNumber.$': '$.pageNumber',
        'filename.$': '$.filename',
      }),
      resultPath: '$.ocrResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    ocrPageTask.addRetry({
      errors: ['States.ALL'],
      interval: Duration.seconds(30),
      maxAttempts: 3,
      backoffRate: 2,
    });

    // Classify + extract for PDF pages (markdown comes from OCR result)
    const classifyExtractTask = new tasks.LambdaInvoke(this, 'ClassifyAndExtract', {
      lambdaFunction: classifyExtractFn,
      payload: sfn.TaskInput.fromObject({
        'markdown.$': '$.ocrResult.Payload.markdown',
        'pageNumber.$': '$.pageNumber',
        'filename.$': '$.filename',
      }),
      resultPath: '$.classifyResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
    });

    const pdfMapChain = convertToImageTask
      .next(ocrPageTask)
      .next(classifyExtractTask);

    const processPages = new sfn.Map(this, 'ProcessPages', {
      maxConcurrency: 3,
      itemsPath: '$.splitResult.Payload.generated',
      resultPath: '$.mapResults',
    });
    processPages.itemProcessor(pdfMapChain);

    const pdfPath = splitPdfTask.next(processPages);

    // ---- Excel Path ----

    // Convert Excel sheets to markdown text
    const excelToSheetsTask = new tasks.LambdaInvoke(this, 'ExcelToSheets', {
      lambdaFunction: excelToTextFn,
      resultPath: '$.splitResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });

    // Classify + extract for Excel sheets (markdown comes directly from sheet conversion)
    const classifyExtractExcelTask = new tasks.LambdaInvoke(this, 'ClassifyAndExtractExcel', {
      lambdaFunction: classifyExtractFn,
      payload: sfn.TaskInput.fromObject({
        'markdown.$': '$.markdown',
        'pageNumber.$': '$.pageNumber',
        'filename.$': '$.filename',
      }),
      resultPath: '$.classifyResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
    });

    const processSheets = new sfn.Map(this, 'ProcessSheets', {
      maxConcurrency: 3,
      itemsPath: '$.splitResult.Payload.generated',
      resultPath: '$.mapResults',
    });
    processSheets.itemProcessor(classifyExtractExcelTask);

    const excelPath = excelToSheetsTask.next(processSheets);

    // ---- Route by file type ----

    const fileTypeChoice = new sfn.Choice(this, 'DetectFileType');
    fileTypeChoice
      .when(sfn.Condition.stringEquals('$.fileType', 'excel'), excelPath)
      .otherwise(pdfPath);

    // ---- Common tail: collect + save ----

    const collectResults = new sfn.Pass(this, 'CollectResults', {
      parameters: {
        'mapResults.$': '$.mapResults',
        'originalKey.$': '$.splitResult.Payload.originalKey',
        'totalPages.$': '$.splitResult.Payload.totalPages',
        'bucket.$': '$.splitResult.Payload.bucket',
      },
    });

    const saveToS3Task = new tasks.LambdaInvoke(this, 'SaveToS3', {
      lambdaFunction: saveResultsFn,
      taskTimeout: sfn.Timeout.duration(Duration.minutes(1)),
    });

    // Wire up: Choice -> (PDF | Excel) -> CollectResults -> SaveToS3
    const definition = fileTypeChoice
      .afterwards()
      .next(collectResults)
      .next(saveToS3Task);

    this.stateMachine = new sfn.StateMachine(
      this,
      getCdkConstructId({ resourceName: 'pipeline-sfn' }, scope),
      {
        stateMachineName: getCdkConstructId({ resourceName: 'pipeline' }, this),
        definitionBody: sfn.DefinitionBody.fromChainable(definition),
        timeout: Duration.hours(1),
        tracingEnabled: true,
        logs: {
          destination: sfnLogGroup,
          level: sfn.LogLevel.ALL,
          includeExecutionData: true,
        },
      },
    );

    // ========== Start Pipeline Lambda (needs state machine ARN) ==========

    this.startPipelineLambda = createStartPipelineLambda(
      this,
      {
        REGION: this.region,
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
        FILES_BUCKET: fileBucketName,
      },
      startPipelineRole,
    );

    // Grant start-pipeline Lambda permission to start executions
    startPipelineRole.addToPolicy(getPolicyStatement({
      service: 'states',
      operations: ['StartExecution'],
      resources: [this.stateMachine.stateMachineArn],
    }));

    // ========== cdk-nag Suppressions ==========

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions needed for CloudWatch Logs, VPC networking, and Bedrock foundation model access',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policies used for Lambda basic execution role',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Docker-based Lambdas use custom container runtimes; Node.js Lambdas use NODEJS_22_X (latest LTS)',
      },
    ]);
  }
}
