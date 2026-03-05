import { uploadFile } from '../../../../shared/services/S3';

const FILES_BUCKET = process.env.FILES_BUCKET || '';

interface PageResult {
  pageNumber: number;
  pdfKey: string;
  pdfBucket: string;
  filename: string;
  convertResult: {
    Payload: {
      imageKey: string;
      imageBucket: string;
      pageNumber: number;
      filename: string;
    };
  };
  ocrResult: {
    Payload: {
      markdown: string;
      pageNumber: number;
      filename: string;
      success: boolean;
    };
  };
  classifyResult: {
    Payload: {
      pageNumber: number;
      filename: string;
      documentType: string;
      confidence: number;
      extraction: any;
      markdown: string;
    };
  };
}

interface SaveResultsEvent {
  mapResults: PageResult[];
  originalKey: string;
  totalPages: number;
  bucket: string;
}

export const handler = async (event: SaveResultsEvent) => {
  console.log('SaveResults event, pages:', event.mapResults?.length);

  const { mapResults, originalKey, totalPages, bucket } = event;
  const useBucket = bucket || FILES_BUCKET;

  // Extract base filename from original key
  const baseFilename = originalKey.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'unknown';

  // Group results by document type
  const byType: Record<string, any[]> = {};
  const pages: any[] = [];

  for (const item of mapResults) {
    const classify = item.classifyResult?.Payload || {} as any;
    const pageData = {
      pageNumber: classify.pageNumber || item.pageNumber,
      documentType: classify.documentType || 'other',
      confidence: classify.confidence || 0,
      extraction: classify.extraction,
      markdown: classify.markdown || item.ocrResult?.Payload?.markdown || '',
      imageKey: item.convertResult?.Payload?.imageKey || '',
    };

    pages.push(pageData);

    const type = pageData.documentType;
    if (!byType[type]) byType[type] = [];
    byType[type].push(pageData);
  }

  // Sort pages by page number
  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  // Build consolidated result
  const result = {
    originalKey,
    totalPages,
    processedAt: new Date().toISOString(),
    summary: {
      documentTypes: Object.fromEntries(
        Object.entries(byType).map(([type, items]) => [type, items.length]),
      ),
    },
    pages,
    byDocumentType: byType,
  };

  // Write to S3
  const resultKey = `pipeline/results/${baseFilename}/results.json`;
  await uploadFile(useBucket, resultKey, result);

  console.log(`Results saved to s3://${useBucket}/${resultKey}`);

  return {
    resultKey,
    bucket: useBucket,
    totalPages,
    documentTypeCounts: result.summary.documentTypes,
  };
};
