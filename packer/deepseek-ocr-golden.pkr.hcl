# DeepSeek-OCR Golden AMI Packer Template
# Pre-bakes NVIDIA drivers, vLLM, and DeepSeek-OCR-2 model for fast cold starts

packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "model_name" {
  type    = string
  default = "deepseek-ai/DeepSeek-OCR-2"
}

variable "ami_name_prefix" {
  type    = string
  default = "deepseek-ocr-golden"
}

variable "vpc_id" {
  type    = string
  default = ""
}

variable "subnet_id" {
  type    = string
  default = ""
}

# Data source to find the latest ECS GPU-optimized AMI
data "amazon-ami" "ecs_gpu_ami" {
  filters = {
    name                = "amzn2-ami-ecs-gpu-hvm-*-x86_64-ebs"
    virtualization-type = "hvm"
    root-device-type    = "ebs"
  }
  most_recent = true
  owners      = ["amazon"]
  region      = var.aws_region
}

locals {
  timestamp = formatdate("YYYYMMDD-HHmmss", timestamp())
}

source "amazon-ebs" "deepseek_ocr" {
  ami_name        = "${var.ami_name_prefix}-${local.timestamp}"
  ami_description = "DeepSeek-OCR Golden AMI with pre-baked model and dependencies"
  instance_type   = var.instance_type
  region          = var.aws_region
  source_ami      = data.amazon-ami.ecs_gpu_ami.id

  # Use default VPC if not specified
  vpc_id    = var.vpc_id != "" ? var.vpc_id : null
  subnet_id = var.subnet_id != "" ? var.subnet_id : null

  # Instance configuration
  associate_public_ip_address = true

  # Storage - 200GB for model and Docker images
  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 200
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  # Tags
  tags = {
    Name        = "${var.ami_name_prefix}-${local.timestamp}"
    Project     = "deepseek-ocr"
    Model       = var.model_name
    ManagedBy   = "packer"
    CreatedAt   = local.timestamp
  }

  run_tags = {
    Name = "packer-builder-deepseek-ocr"
  }

  # SSH configuration
  ssh_username = "ec2-user"

  # Increase timeout for model download
  ssh_timeout = "30m"
}

build {
  name    = "deepseek-ocr-golden"
  sources = ["source.amazon-ebs.deepseek_ocr"]

  # Wait for cloud-init to complete
  provisioner "shell" {
    inline = [
      "echo 'Waiting for cloud-init to complete...'",
      "sudo cloud-init status --wait || true",
      "echo 'Cloud-init complete.'"
    ]
  }

  # Install system dependencies
  provisioner "shell" {
    inline = [
      "echo '=== Installing system dependencies ==='",
      "sudo yum update -y",
      "sudo yum install -y git python3-pip docker",

      "# Ensure Docker is running",
      "sudo systemctl start docker",
      "sudo systemctl enable docker",

      "# Add ec2-user to docker group",
      "sudo usermod -aG docker ec2-user"
    ]
  }

  # Install NVIDIA container toolkit (if not already present)
  provisioner "shell" {
    inline = [
      "echo '=== Configuring NVIDIA container toolkit ==='",

      "# Install nvidia-docker2 if not present",
      "if ! command -v nvidia-container-toolkit &> /dev/null; then",
      "  distribution=$(. /etc/os-release;echo $ID$VERSION_ID)",
      "  curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.repo | sudo tee /etc/yum.repos.d/nvidia-docker.repo",
      "  sudo yum install -y nvidia-docker2",
      "fi",

      "# Restart Docker to apply NVIDIA runtime",
      "sudo systemctl restart docker",

      "# Verify NVIDIA driver and runtime",
      "nvidia-smi || echo 'Warning: nvidia-smi failed, this may be expected during AMI build'",
      "docker info | grep -i nvidia || echo 'NVIDIA runtime configured'"
    ]
  }

  # Create model cache directory
  provisioner "shell" {
    inline = [
      "echo '=== Creating model cache directory ==='",
      "sudo mkdir -p /mnt/ecs-data/models",
      "sudo chmod 777 /mnt/ecs-data/models"
    ]
  }

  # Install Python dependencies for model download
  provisioner "shell" {
    inline = [
      "echo '=== Installing Python dependencies ==='",
      "sudo pip3 install --upgrade pip",
      "sudo pip3 install huggingface_hub transformers torch",

      "# Set Hugging Face cache directory",
      "export HF_HOME=/mnt/ecs-data/models",
      "export TRANSFORMERS_CACHE=/mnt/ecs-data/models",
      "export HUGGINGFACE_HUB_CACHE=/mnt/ecs-data/models"
    ]
  }

  # Pre-download the DeepSeek-OCR-2 model
  provisioner "shell" {
    environment_vars = [
      "HF_HOME=/mnt/ecs-data/models",
      "TRANSFORMERS_CACHE=/mnt/ecs-data/models",
      "HUGGINGFACE_HUB_CACHE=/mnt/ecs-data/models",
      "MODEL_NAME=${var.model_name}"
    ]
    inline = [
      "echo '=== Downloading DeepSeek-OCR-2 model ==='",
      "echo 'Model: ${var.model_name}'",
      "echo 'Cache directory: /mnt/ecs-data/models'",

      "# Download the model using huggingface-cli",
      "python3 -c \"",
      "from huggingface_hub import snapshot_download",
      "import os",
      "model_name = os.environ.get('MODEL_NAME', 'deepseek-ai/DeepSeek-OCR-2')",
      "cache_dir = '/mnt/ecs-data/models'",
      "print(f'Downloading {model_name} to {cache_dir}...')",
      "snapshot_download(",
      "    repo_id=model_name,",
      "    cache_dir=cache_dir,",
      "    local_dir=f'{cache_dir}/{model_name.replace(\"/\", \"--\")}',",
      "    local_dir_use_symlinks=False",
      ")",
      "print('Model download complete!')",
      "\"",

      "# Verify model files exist",
      "echo 'Verifying model files...'",
      "ls -la /mnt/ecs-data/models/",
      "du -sh /mnt/ecs-data/models/"
    ]
  }

  # Configure ECS agent
  provisioner "shell" {
    inline = [
      "echo '=== Configuring ECS agent ==='",

      "# Create ECS config directory",
      "sudo mkdir -p /etc/ecs",

      "# Configure ECS agent (cluster name will be set by user data at launch)",
      "sudo tee /etc/ecs/ecs.config > /dev/null <<'EOF'",
      "ECS_ENABLE_GPU_SUPPORT=true",
      "ECS_ENABLE_SPOT_INSTANCE_DRAINING=true",
      "ECS_IMAGE_PULL_BEHAVIOR=prefer-cached",
      "ECS_ENABLE_CONTAINER_METADATA=true",
      "EOF",

      "echo 'ECS agent configured.'"
    ]
  }

  # Install vLLM and dependencies for potential direct inference
  provisioner "shell" {
    inline = [
      "echo '=== Installing vLLM and inference dependencies ==='",

      "# Install vLLM (optional - main inference happens in Docker)",
      "sudo pip3 install vllm==0.8.5 || echo 'vLLM installation skipped (will use Docker image)'",

      "# Install flash-attn for optimal performance",
      "sudo pip3 install flash-attn==2.7.3 --no-build-isolation || echo 'flash-attn installation skipped'",

      "# Install other dependencies",
      "sudo pip3 install einops easydict addict Pillow PyMuPDF img2pdf"
    ]
  }

  # Clean up and prepare for launch
  provisioner "shell" {
    inline = [
      "echo '=== Final cleanup ==='",

      "# Clean up package manager cache",
      "sudo yum clean all",
      "sudo rm -rf /var/cache/yum",

      "# Clean up pip cache",
      "sudo pip3 cache purge || true",

      "# Clear cloud-init state for fresh instance launch",
      "sudo rm -rf /var/lib/cloud/instances/*",

      "# Show disk usage",
      "df -h",

      "echo '=== Golden AMI build complete ==='",
      "echo 'Model cached at: /mnt/ecs-data/models'",
      "ls -la /mnt/ecs-data/models/"
    ]
  }

  # Output AMI information
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
    custom_data = {
      model_name = var.model_name
      region     = var.aws_region
    }
  }
}
