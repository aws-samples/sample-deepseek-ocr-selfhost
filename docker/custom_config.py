# Custom configuration for DeepSeek-OCR-2 vLLM
# This file replaces the original config.py during Docker build
# Modify the PROMPT value below to change the default prompt used by the OCR service

import os

# Processing modes for different use cases:
# Tiny: base_size = 512, image_size = 512, crop_mode = False
# Small: base_size = 640, image_size = 640, crop_mode = False
# Base: base_size = 1024, image_size = 1024, crop_mode = False
# Large: base_size = 1280, image_size = 1280, crop_mode = False
# Gundam: base_size = 1024, image_size = 768, crop_mode = True (recommended for OCR-2)

BASE_SIZE = 1024
IMAGE_SIZE = 768  # Updated for DeepSeek-OCR-2 (larger than OCR-1)
CROP_MODE = True
MIN_CROPS = 2
MAX_CROPS = 6  # max:9; If your GPU memory is small, it is recommended to set it to 6.
MAX_CONCURRENCY = 100  # If you have limited GPU memory, lower the concurrency count.
NUM_WORKERS = 64  # image pre-process (resize/padding) workers
PRINT_NUM_VIS_TOKENS = False
SKIP_REPEAT = True

# DeepSeek-OCR-2 Model Configuration
# Use environment variables for flexibility (Golden AMI may override)
MODEL_PATH = os.environ.get('MODEL_PATH', 'deepseek-ai/DeepSeek-OCR-2')
VLLM_TORCH_DTYPE = os.environ.get('VLLM_TORCH_DTYPE', 'bfloat16')  # BF16 for g5 (A10G GPU)

# Check for pre-cached model in Golden AMI location
GOLDEN_AMI_MODEL_CACHE = '/mnt/ecs-data/models'
if os.path.exists(GOLDEN_AMI_MODEL_CACHE):
    # Use Golden AMI pre-cached model if available
    os.environ.setdefault('HF_HOME', GOLDEN_AMI_MODEL_CACHE)
    os.environ.setdefault('TRANSFORMERS_CACHE', GOLDEN_AMI_MODEL_CACHE)
    os.environ.setdefault('HUGGINGFACE_HUB_CACHE', GOLDEN_AMI_MODEL_CACHE)

INPUT_PATH = ''
OUTPUT_PATH = ''

# CUSTOMIZABLE PROMPT - Modify this line to change the default prompt
# The API will still accept custom prompts via the prompt parameter
PROMPT = '<image>\n<|grounding|>Convert the document to markdown.'

from transformers import AutoTokenizer

TOKENIZER = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
