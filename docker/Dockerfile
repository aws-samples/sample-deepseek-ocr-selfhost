# Multi-stage build to optimize final image size
FROM nvidia/cuda:11.8-runtime-ubuntu20.04 as model-downloader

# Install Python and required tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Hugging Face CLI
RUN pip3 install huggingface_hub

# Download DeepSeek-OCR model (this will be ~9GB)
WORKDIR /models
RUN huggingface-cli download deepseek-ai/DeepSeek-OCR --local-dir deepseek-ai/DeepSeek-OCR

# Main runtime stage
FROM nvidia/cuda:11.8-runtime-ubuntu20.04

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV CUDA_VISIBLE_DEVICES=0
ENV MODEL_PATH=/app/models/deepseek-ai/DeepSeek-OCR
ENV MAX_CONCURRENCY=50
ENV GPU_MEMORY_UTILIZATION=0.85

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    git \
    wget \
    curl \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy model from build stage
COPY --from=model-downloader /models /app/models

# Clone DeepSeek-OCR repository
RUN git clone https://github.com/deepseek-ai/DeepSeek-OCR.git && \
    cd DeepSeek-OCR && \
    git checkout main

# Install Python dependencies
RUN cd DeepSeek-OCR && \
    pip3 install --no-cache-dir -r requirements.txt && \
    pip3 install fastapi uvicorn python-multipart Pillow PyMuPDF

# Copy custom configuration files
COPY custom_config.py DeepSeek-OCR/config.py
COPY custom_image_process.py DeepSeek-OCR/process/image_process.py
COPY custom_run_dpsk_ocr_pdf.py DeepSeek-OCR/run_dpsk_ocr_pdf.py
COPY custom_run_dpsk_ocr_image.py DeepSeek-OCR/run_dpsk_ocr_image.py
COPY custom_run_dpsk_ocr_eval_batch.py DeepSeek-OCR/run_dpsk_ocr_eval_batch.py

# Copy FastAPI server
COPY start_server.py /app/start_server.py

# Make scripts executable
RUN chmod +x /app/start_server.py

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Start FastAPI server
CMD ["python3", "/app/start_server.py"]
