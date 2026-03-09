import os
import io
import boto3
from pdf2image import convert_from_bytes
from PIL import Image

s3 = boto3.client('s3', region_name=os.environ.get('REGION', 'us-east-1'))
FILES_BUCKET = os.environ.get('FILES_BUCKET', '')

MAX_DIMENSION = 1920  # Max dimension for vision model input


def _resize_for_vision_model(image):
    """Resize image if larger than max dimension while maintaining aspect ratio."""
    width, height = image.size
    if width <= MAX_DIMENSION and height <= MAX_DIMENSION:
        return image

    ratio = min(MAX_DIMENSION / width, MAX_DIMENSION / height)
    new_size = (int(width * ratio), int(height * ratio))
    return image.resize(new_size, Image.LANCZOS)


def _save_image_to_s3(image, bucket, key):
    """Save PIL Image to S3 as JPEG."""
    buf = io.BytesIO()
    image.save(buf, format='JPEG', quality=95)
    buf.seek(0)

    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=buf.getvalue(),
        ContentType='image/jpeg',
    )
    return key


def handler(event, context):
    """Convert a single-page PDF to a JPEG image."""
    pdf_key = event['pdfKey']
    bucket = event.get('pdfBucket', FILES_BUCKET)
    page_number = event['pageNumber']
    filename = event['filename']

    # Download single-page PDF from S3
    response = s3.get_object(Bucket=bucket, Key=pdf_key)
    pdf_bytes = response['Body'].read()

    # Convert PDF page to image using Poppler
    images = convert_from_bytes(pdf_bytes, dpi=300)

    if not images:
        raise ValueError(f"No images generated from PDF: {pdf_key}")

    # Take the first (and only) page
    image = images[0]

    # Resize for vision model
    image = _resize_for_vision_model(image)

    # Upload to S3
    image_key = f"pipeline/images/{filename}/page-{page_number}.jpg"
    _save_image_to_s3(image, bucket, image_key)

    print(f"Converted {pdf_key} -> {image_key} ({image.size[0]}x{image.size[1]})")

    return {
        'imageKey': image_key,
        'imageBucket': bucket,
        'pageNumber': page_number,
        'filename': filename,
    }
