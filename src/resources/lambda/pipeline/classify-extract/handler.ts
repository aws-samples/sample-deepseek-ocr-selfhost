import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { CLASSIFICATION_PROMPT, EXTRACTION_PROMPTS } from './prompts';

const REGION = process.env.REGION || 'us-east-1';
const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

const client = new BedrockRuntimeClient({ region: REGION });

interface ClassifyExtractEvent {
  markdown: string;
  pageNumber: number;
  filename: string;
}

async function invokeModel(prompt: string): Promise<string> {
  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await client.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0].text;
}

function parseJson(text: string): any {
  // Try to extract JSON from the response (handles markdown code blocks too)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error(`Could not parse JSON from response: ${text.substring(0, 200)}`);
}

export const handler = async (event: ClassifyExtractEvent) => {
  console.log('ClassifyAndExtract event:', JSON.stringify(event).substring(0, 500));

  const { markdown, pageNumber, filename } = event;

  // Skip empty pages
  if (!markdown || markdown.trim().length === 0) {
    console.log(`Page ${pageNumber} is empty, skipping classification`);
    return {
      pageNumber,
      filename,
      documentType: 'other',
      confidence: 0,
      extraction: null,
    };
  }

  // Step 1: Classify document type
  const classificationPrompt = CLASSIFICATION_PROMPT.replace('{text}', markdown);
  const classificationResponse = await invokeModel(classificationPrompt);

  let classification: { documentType: string; confidence: number };
  try {
    classification = parseJson(classificationResponse);
  } catch (e) {
    console.error('Failed to parse classification:', classificationResponse);
    classification = { documentType: 'other', confidence: 0 };
  }

  console.log(`Page ${pageNumber} classified as: ${classification.documentType} (confidence: ${classification.confidence})`);

  // Step 2: Extract structured data if we have a known document type
  let extraction: any = null;
  const extractionPrompt = EXTRACTION_PROMPTS[classification.documentType];

  if (extractionPrompt) {
    const extractionInput = extractionPrompt.replace('{text}', markdown);
    const extractionResponse = await invokeModel(extractionInput);

    try {
      extraction = parseJson(extractionResponse);
    } catch (e) {
      console.error('Failed to parse extraction:', extractionResponse);
      extraction = { raw: extractionResponse };
    }
  }

  return {
    pageNumber,
    filename,
    documentType: classification.documentType,
    confidence: classification.confidence,
    extraction,
    markdown,
  };
};
