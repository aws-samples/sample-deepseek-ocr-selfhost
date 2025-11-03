"""
Custom configuration for DeepSeek-OCR
Fixes the original config.py to handle prompt parameter correctly
"""

import os

# Model configuration
MODEL_PATH = os.getenv('MODEL_PATH', '/app/models/deepseek-ai/DeepSeek-OCR')

# Default prompt for OCR processing
PROMPT = '<image>\n<|grounding|>Convert the document to markdown.'

# Server configuration
MAX_CONCURRENCY = int(os.getenv('MAX_CONCURRENCY', '50'))
GPU_MEMORY_UTILIZATION = float(os.getenv('GPU_MEMORY_UTILIZATION', '0.85'))

# Processing configuration
DPI = 144
MAX_IMAGE_SIZE = (2048, 2048)
SUPPORTED_IMAGE_FORMATS = ['PNG', 'JPEG', 'JPG', 'TIFF', 'BMP', 'GIF']
SUPPORTED_PDF_FORMATS = ['pdf']

# API configuration
API_HOST = os.getenv('HOST', '0.0.0.0')
API_PORT = int(os.getenv('PORT', '8000'))

# Logging configuration
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

# Custom prompts for different use cases
PROMPTS = {
    'markdown': '<image>\n<|grounding|>Convert the document to markdown.',
    'ocr': '<image>\nFree OCR.',
    'tables': '<image>\n<|grounding|>Extract all tables and format them as markdown tables.',
    'course_catalog': '<image>\n<|grounding|>Extract course information including course number, title, credits, and description. Format as structured data.',
}

def get_prompt(prompt_type: str = 'markdown') -> str:
    """Get prompt by type"""
    return PROMPTS.get(prompt_type, PROMPTS['markdown'])

def validate_config():
    """Validate configuration"""
    if not os.path.exists(MODEL_PATH):
        raise ValueError(f"Model path does not exist: {MODEL_PATH}")
    
    if MAX_CONCURRENCY <= 0:
        raise ValueError(f"MAX_CONCURRENCY must be positive: {MAX_CONCURRENCY}")
    
    if not (0.1 <= GPU_MEMORY_UTILIZATION <= 1.0):
        raise ValueError(f"GPU_MEMORY_UTILIZATION must be between 0.1 and 1.0: {GPU_MEMORY_UTILIZATION}")

# Validate on import
try:
    validate_config()
    print(f"Configuration loaded successfully:")
    print(f"  Model Path: {MODEL_PATH}")
    print(f"  Max Concurrency: {MAX_CONCURRENCY}")
    print(f"  GPU Memory Utilization: {GPU_MEMORY_UTILIZATION}")
except Exception as e:
    print(f"Configuration validation failed: {e}")
