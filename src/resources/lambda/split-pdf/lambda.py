import os
import io
import boto3
from pypdf import PdfReader, PdfWriter

s3 = boto3.client('s3', region_name=os.environ.get('REGION', 'us-east-1'))
FILES_BUCKET = os.environ.get('FILES_BUCKET', '')


def handler(event, context):
    """Split a PDF into individual single-page PDFs in S3."""
    s3_key = event['s3Key']
    bucket = event.get('bucket', FILES_BUCKET)

    # Extract base filename without extension
    filename = os.path.splitext(os.path.basename(s3_key))[0]

    # Download PDF from S3
    response = s3.get_object(Bucket=bucket, Key=s3_key)
    pdf_bytes = response['Body'].read()

    reader = PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)

    generated = []

    for i, page in enumerate(reader.pages):
        page_number = i + 1
        writer = PdfWriter()
        writer.add_page(page)

        buf = io.BytesIO()
        writer.write(buf)
        buf.seek(0)

        page_key = f"pipeline/pages/{filename}/page-{page_number}.pdf"
        s3.put_object(
            Bucket=bucket,
            Key=page_key,
            Body=buf.getvalue(),
            ContentType='application/pdf',
        )

        generated.append({
            'pageNumber': page_number,
            'pdfKey': page_key,
            'pdfBucket': bucket,
            'filename': filename,
        })

    print(f"Split {s3_key} into {total_pages} pages")

    return {
        'generated': generated,
        'totalPages': total_pages,
        'originalKey': s3_key,
        'bucket': bucket,
    }
