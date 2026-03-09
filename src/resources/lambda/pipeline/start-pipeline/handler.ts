import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { getLambdaResponse } from '../../../../shared/cdk-helpers';
import { ClientError, errorHandler } from '../../../../shared/services/Errors';
import { LambdaHandlerEvent } from '../../../../shared/types';

const REGION = process.env.REGION || 'us-east-1';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN || '';
const FILES_BUCKET = process.env.FILES_BUCKET || '';

const sfnClient = new SFNClient({ region: REGION });

export const handler = async (event: LambdaHandlerEvent) => {
  try {
    console.log('StartPipeline event:', JSON.stringify(event));

    const body = JSON.parse(event.body);
    const { s3Key } = body;

    if (!s3Key) {
      throw new ClientError('Required field s3Key is missing', 400);
    }

    // Detect file type for Step Functions routing
    const lowerKey = s3Key.toLowerCase();
    const fileType = lowerKey.endsWith('.xlsx') || lowerKey.endsWith('.xls') ? 'excel' : 'pdf';

    const executionInput = JSON.stringify({
      s3Key,
      bucket: FILES_BUCKET,
      fileType,
    });

    // Create a safe execution name (alphanumeric, hyphens, underscores only, max 80 chars)
    const safeName = `pipeline-${Date.now()}-${s3Key.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 40)}`;

    const command = new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      input: executionInput,
      name: safeName,
    });

    const result = await sfnClient.send(command);

    console.log(`Started execution: ${result.executionArn}`);

    return getLambdaResponse({
      executionArn: result.executionArn,
      startDate: result.startDate?.toISOString(),
    });
  } catch (e) {
    console.error('StartPipeline error:', e);
    return errorHandler(e as Error);
  }
};
