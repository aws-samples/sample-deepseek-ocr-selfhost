import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy } from 'aws-cdk-lib';

export interface DeepSeekOcrEcrProps {
  /**
   * Repository name for the ECR repository
   */
  repositoryName?: string;
  
  /**
   * Number of images to keep in the repository
   */
  maxImageCount?: number;
  
  /**
   * Whether to enable image scanning
   */
  imageScanOnPush?: boolean;
}

export class DeepSeekOcrEcr extends Construct {
  public readonly repository: ecr.Repository;
  public readonly repositoryUri: string;
  
  constructor(scope: Construct, id: string, props: DeepSeekOcrEcrProps = {}) {
    super(scope, id);
    
    const {
      repositoryName = 'deepseek-ocr',
      maxImageCount = 10,
      imageScanOnPush = true,
    } = props;
    
    // Create ECR repository for DeepSeek-OCR Docker images
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName,
      imageScanOnPush,
      removalPolicy: RemovalPolicy.DESTROY, // For development - change to RETAIN for production
      
      // Lifecycle policy to manage storage costs
      lifecycleRules: [
        {
          description: 'Keep only the latest images',
          maxImageCount,
          rulePriority: 1,
        },
      ],
    });
    
    this.repositoryUri = this.repository.repositoryUri;
    
    // Grant permissions for ECS to pull images
    this.repository.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('ecs-tasks.amazonaws.com')],
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
    }));
    
    // Grant permissions for CodeBuild/GitHub Actions to push images
    this.repository.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('codebuild.amazonaws.com')],
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
      ],
    }));
  }
}
