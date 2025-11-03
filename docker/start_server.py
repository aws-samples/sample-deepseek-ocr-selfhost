#!/usr/bin/env python3
"""
FastAPI server for DeepSeek OCR processing
Based on the Bogdanovich77 implementation with enhancements for AWS deployment
"""

import os
import sys
import json
import tempfile
import traceback
from typing import List, Optional
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import PyMuPDF  # fitz
from PIL import Image
import io

# Add DeepSeek-OCR to Python path
sys.path.insert(0, '/app/DeepSeek-OCR')

# Import DeepSeek OCR modules
try:
    from config import MODEL_PATH, PROMPT
    from process.image_process import DeepseekOCRProcessor
except ImportError as e:
    print(f"Failed to import DeepSeek-OCR modules: {e}")
    sys.exit(1)

# Initialize FastAPI app
app = FastAPI(
    title="DeepSeek OCR API",
    description="PDF and Image OCR processing with DeepSeek-OCR",
    version="1.0.0"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global OCR processor instance
ocr_processor = None

def initialize_ocr():
    """Initialize the OCR processor"""
    global ocr_processor
    try:
        print(f"Initializing DeepSeek OCR with model path: {MODEL_PATH}")
        ocr_processor = DeepseekOCRProcessor()
        print("DeepSeek OCR initialized successfully")
        return True
    except Exception as e:
        print(f"Failed to initialize OCR processor: {e}")
        traceback.print_exc()
        return False

def pdf_to_images(pdf_bytes: bytes, dpi: int = 144) -> List[Image.Image]:
    """Convert PDF to images"""
    images = []
    try:
        pdf_doc = PyMuPDF.open(stream=pdf_bytes, filetype="pdf")
        
        for page_num in range(len(pdf_doc)):
            page = pdf_doc.load_page(page_num)
            mat = PyMuPDF.Matrix(dpi/72, dpi/72)  # Scale factor for DPI
            pix = page.get_pixmap(matrix=mat)
            img_data = pix.tobytes("png")
            image = Image.open(io.BytesIO(img_data))
            images.append(image)
            
        pdf_doc.close()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to process PDF: {str(e)}")
    
    return images

def process_image_ocr(image: Image.Image, custom_prompt: Optional[str] = None) -> dict:
    """Process single image with OCR"""
    try:
        # Use custom prompt if provided, otherwise use default
        prompt = custom_prompt or PROMPT
        
        # Convert PIL Image to format expected by DeepSeek OCR
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp_file:
            image.save(tmp_file.name, 'PNG')
            
            # Process with DeepSeek OCR
            result = ocr_processor.process_image(tmp_file.name, prompt)
            
            # Clean up temporary file
            os.unlink(tmp_file.name)
            
            return {
                "success": True,
                "result": result,
                "page_count": 1
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "page_count": 0
        }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model_loaded": ocr_processor is not None,
        "model_path": MODEL_PATH,
        "cuda_available": True,  # Assuming CUDA is available in Docker
        "cuda_device_count": 1
    }

@app.post("/ocr/image")
async def process_image(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form(None)
):
    """Process single image file"""
    if ocr_processor is None:
        raise HTTPException(status_code=503, detail="OCR service not initialized")
    
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    try:
        # Read and process image
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes))
        
        # Process with OCR
        result = process_image_ocr(image, prompt)
        
        return JSONResponse(content=result)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")

@app.post("/ocr/pdf")
async def process_pdf(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    dpi: int = Form(144)
):
    """Process PDF file"""
    if ocr_processor is None:
        raise HTTPException(status_code=503, detail="OCR service not initialized")
    
    if file.content_type != 'application/pdf':
        raise HTTPException(status_code=400, detail="File must be a PDF")
    
    try:
        # Read PDF
        pdf_bytes = await file.read()
        
        # Convert to images
        images = pdf_to_images(pdf_bytes, dpi)
        
        # Process each page
        results = []
        for page_num, image in enumerate(images):
            result = process_image_ocr(image, prompt)
            result['page_count'] = page_num + 1
            results.append(result)
        
        return JSONResponse(content={
            "success": True,
            "results": results,
            "total_pages": len(images),
            "filename": file.filename
        })
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {str(e)}")

@app.post("/ocr/batch")
async def process_batch(
    files: List[UploadFile] = File(...),
    prompt: Optional[str] = Form(None),
    dpi: int = Form(144)
):
    """Process multiple files"""
    if ocr_processor is None:
        raise HTTPException(status_code=503, detail="OCR service not initialized")
    
    results = []
    
    for file in files:
        try:
            if file.content_type == 'application/pdf':
                # Process PDF
                pdf_bytes = await file.read()
                images = pdf_to_images(pdf_bytes, dpi)
                
                page_results = []
                for page_num, image in enumerate(images):
                    result = process_image_ocr(image, prompt)
                    result['page_count'] = page_num + 1
                    page_results.append(result)
                
                results.append({
                    "filename": file.filename,
                    "type": "pdf",
                    "success": True,
                    "results": page_results,
                    "total_pages": len(images)
                })
                
            elif file.content_type.startswith('image/'):
                # Process image
                image_bytes = await file.read()
                image = Image.open(io.BytesIO(image_bytes))
                result = process_image_ocr(image, prompt)
                
                results.append({
                    "filename": file.filename,
                    "type": "image",
                    "success": True,
                    "result": result['result'],
                    "page_count": 1
                })
                
            else:
                results.append({
                    "filename": file.filename,
                    "success": False,
                    "error": "Unsupported file type"
                })
                
        except Exception as e:
            results.append({
                "filename": file.filename,
                "success": False,
                "error": str(e)
            })
    
    return JSONResponse(content={
        "success": True,
        "results": results,
        "total_files": len(files)
    })

if __name__ == "__main__":
    print("Starting DeepSeek OCR FastAPI server...")
    
    # Initialize OCR processor
    if not initialize_ocr():
        print("Failed to initialize OCR processor. Exiting.")
        sys.exit(1)
    
    # Start server
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")
    
    print(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, workers=1)
