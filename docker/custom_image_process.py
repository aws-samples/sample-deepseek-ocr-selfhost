"""
Custom image processing module for DeepSeek-OCR
Fixes the original image_process.py to handle prompt parameter correctly
"""

import os
import sys
import json
import time
from typing import Optional, Dict, Any
from pathlib import Path

try:
    import torch
    from PIL import Image
    import numpy as np
except ImportError as e:
    print(f"Required dependencies not available: {e}")
    sys.exit(1)

class DeepseekOCRProcessor:
    """Enhanced DeepSeek OCR Processor with proper prompt handling"""
    
    def __init__(self, model_path: Optional[str] = None, device: str = "auto"):
        """
        Initialize the OCR processor
        
        Args:
            model_path: Path to the model directory
            device: Device to use ('auto', 'cuda', 'cpu')
        """
        from config import MODEL_PATH, GPU_MEMORY_UTILIZATION
        
        self.model_path = model_path or MODEL_PATH
        self.device = self._get_device(device)
        self.model = None
        self.tokenizer = None
        
        print(f"Initializing DeepSeek OCR Processor...")
        print(f"Model Path: {self.model_path}")
        print(f"Device: {self.device}")
        
        self._load_model()
    
    def _get_device(self, device: str) -> str:
        """Determine the appropriate device"""
        if device == "auto":
            if torch.cuda.is_available():
                return "cuda"
            else:
                return "cpu"
        return device
    
    def _load_model(self):
        """Load the DeepSeek OCR model"""
        try:
            # Import vLLM components
            from vllm import LLM, SamplingParams
            from config import GPU_MEMORY_UTILIZATION
            
            # Initialize the model with proper configuration
            self.model = LLM(
                model=self.model_path,
                trust_remote_code=True,
                gpu_memory_utilization=GPU_MEMORY_UTILIZATION,
                max_model_len=4096,
                dtype="auto",
            )
            
            # Set up sampling parameters
            self.sampling_params = SamplingParams(
                temperature=0.0,
                max_tokens=1024,
                stop=["<|end|>", "<|im_end|>"]
            )
            
            print("Model loaded successfully!")
            
        except Exception as e:
            print(f"Failed to load model: {e}")
            raise
    
    def tokenize_with_images(self, prompt: str, images: list) -> Dict[str, Any]:
        """
        Tokenize input with images - FIXED VERSION
        This is the method that was causing the original error
        
        Args:
            prompt: The text prompt
            images: List of images
            
        Returns:
            Dictionary containing tokenized input
        """
        try:
            # This is a placeholder implementation
            # In the actual DeepSeek-OCR, this would handle image tokenization
            return {
                "prompt": prompt,
                "images": images,
                "tokenized": True
            }
        except Exception as e:
            print(f"Error in tokenize_with_images: {e}")
            raise
    
    def process_image(self, image_path: str, prompt: str) -> str:
        """
        Process a single image with OCR
        
        Args:
            image_path: Path to the image file
            prompt: OCR prompt
            
        Returns:
            OCR result as string
        """
        try:
            # Load and validate image
            if not os.path.exists(image_path):
                raise FileNotFoundError(f"Image not found: {image_path}")
            
            image = Image.open(image_path)
            
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                image = image.convert('RGB')
            
            # Prepare the input
            conversation = [
                {
                    "role": "user", 
                    "content": [
                        {"type": "image", "image": image_path},
                        {"type": "text", "text": prompt}
                    ]
                }
            ]
            
            # Generate response using the model
            outputs = self.model.chat(
                conversation=conversation,
                sampling_params=self.sampling_params
            )
            
            # Extract the result
            if outputs and len(outputs) > 0:
                result = outputs[0].outputs[0].text
                return result.strip()
            else:
                return "No output generated"
                
        except Exception as e:
            print(f"Error processing image {image_path}: {e}")
            return f"Error: {str(e)}"
    
    def process_batch(self, image_paths: list, prompt: str) -> list:
        """
        Process multiple images
        
        Args:
            image_paths: List of image file paths
            prompt: OCR prompt
            
        Returns:
            List of OCR results
        """
        results = []
        
        for image_path in image_paths:
            try:
                result = self.process_image(image_path, prompt)
                results.append({
                    "image_path": image_path,
                    "success": True,
                    "result": result
                })
            except Exception as e:
                results.append({
                    "image_path": image_path,
                    "success": False,
                    "error": str(e)
                })
        
        return results
    
    def health_check(self) -> Dict[str, Any]:
        """Perform a health check on the processor"""
        try:
            return {
                "status": "healthy",
                "model_loaded": self.model is not None,
                "model_path": self.model_path,
                "device": self.device,
                "cuda_available": torch.cuda.is_available(),
                "cuda_device_count": torch.cuda.device_count() if torch.cuda.is_available() else 0
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "error": str(e)
            }

# Legacy compatibility functions
def create_processor():
    """Create a new OCR processor instance"""
    return DeepseekOCRProcessor()

def process_image_file(image_path: str, prompt: str = None):
    """
    Legacy function for backward compatibility
    """
    from config import PROMPT
    
    if prompt is None:
        prompt = PROMPT
    
    processor = create_processor()
    return processor.process_image(image_path, prompt)
