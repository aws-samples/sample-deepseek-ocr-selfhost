# DeepSeek-OCR-2 vLLM Docker Image
# Based on official vLLM OpenAI image for better compatibility
# Supports BF16 inference on g5.xlarge (A10G GPU)

FROM vllm/vllm-openai:v0.8.5

# Switch to root user to install packages
USER root

# Set working directory
WORKDIR /app

# Minimal tools to fetch sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Fetch upstream DeepSeek-OCR-2 sources at build time
RUN git clone --depth 1 https://github.com/deepseek-ai/DeepSeek-OCR.git /app/DeepSeek-OCR-src

# Copy the DeepSeek-OCR vLLM implementation (correct nested path)
# Note: DeepSeek-OCR-2 uses the same vLLM implementation structure
RUN cp -r /app/DeepSeek-OCR-src/DeepSeek-OCR-master/DeepSeek-OCR-vllm /app/DeepSeek-OCR-vllm

# Copy custom files to replace the originals (transparent replacement approach)
COPY custom_config.py ./DeepSeek-OCR-vllm/config.py
COPY custom_image_process.py ./DeepSeek-OCR-vllm/process/image_process.py
COPY custom_deepseek_ocr.py ./DeepSeek-OCR-vllm/deepseek_ocr.py

# Copy custom run scripts to replace the originals
COPY custom_run_dpsk_ocr_pdf.py ./DeepSeek-OCR-vllm/run_dpsk_ocr_pdf.py
COPY custom_run_dpsk_ocr_image.py ./DeepSeek-OCR-vllm/run_dpsk_ocr_image.py
COPY custom_run_dpsk_ocr_eval_batch.py ./DeepSeek-OCR-vllm/run_dpsk_ocr_eval_batch.py

# Copy the startup script
COPY start_server.py .

# Upgrade pip and install core dependencies with specific versions for DeepSeek-OCR-2
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    torch==2.6.0 \
    transformers==4.46.3 \
    tokenizers==0.20.3

# Install Python dependencies (explicit list to avoid conflicts)
RUN pip install --no-cache-dir \
    PyMuPDF \
    img2pdf \
    einops \
    easydict \
    addict \
    Pillow \
    numpy

# Install additional dependencies for the API server
RUN pip install --no-cache-dir \
    fastapi==0.104.1 \
    uvicorn[standard]==0.24.0 \
    python-multipart==0.0.6

# Install flash-attn for optimal performance with BF16
# Note: This requires CUDA toolkit and may fail on some systems
RUN pip install --no-cache-dir flash-attn==2.7.3 --no-build-isolation || \
    (echo "WARNING: flash-attn installation failed. The model will still work but may be slower." && \
     echo "This is expected if CUDA development tools are not available in the base image.")

# Add the DeepSeek-OCR directory to PYTHONPATH
ENV PYTHONPATH="/app/DeepSeek-OCR-vllm:${PYTHONPATH}"

# Create directories for outputs and model cache
RUN mkdir -p /app/outputs /app/models

# Set default Hugging Face cache directory
# These can be overridden to use Golden AMI pre-cached models
ENV HF_HOME="/app/models"
ENV TRANSFORMERS_CACHE="/app/models"
ENV HUGGINGFACE_HUB_CACHE="/app/models"

# Default model configuration for DeepSeek-OCR-2
ENV MODEL_PATH="deepseek-ai/DeepSeek-OCR-2"
ENV VLLM_TORCH_DTYPE="bfloat16"

# Make the scripts executable
RUN chmod +x /app/start_server.py

# Expose the API port
EXPOSE 8000

# Set the default command to use our custom server
ENTRYPOINT ["/usr/bin/python3", "/app/start_server.py"]
