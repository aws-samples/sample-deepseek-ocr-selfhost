import { getFileAsBuffer } from '../../../../shared/services/S3';
import { processImage } from '../../processing/helpers';

const FILES_BUCKET = process.env.FILES_BUCKET || '';

interface OcrPageEvent {
  imageKey: string;
  imageBucket: string;
  pageNumber: number;
  filename: string;
}

export const handler = async (event: OcrPageEvent) => {
  console.log('OcrPage event:', JSON.stringify(event));

  const { imageKey, imageBucket, pageNumber, filename } = event;

  // Download image from S3
  const bucket = imageBucket || FILES_BUCKET;
  const imageBuffer = await getFileAsBuffer(bucket, imageKey);
  console.log(`Downloaded image ${imageKey}, size: ${imageBuffer.length} bytes`);

  // Send to DeepSeek OCR via ALB
  const ocrResult = await processImage(imageBuffer);

  console.log(`OCR complete for page ${pageNumber}, result length: ${ocrResult.result?.length || 0} chars`);

  return {
    markdown: ocrResult.result || '',
    pageNumber,
    filename,
    imageKey,
    success: ocrResult.success,
  };
};
