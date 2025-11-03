import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy, Duration } from 'aws-cdk-lib';

export interface DataStorageProps {
  /**
   * Environment name for naming resources
   */
  environment?: string;
  
  /**
   * Whether to enable versioning on S3 buckets
   */
  enableVersioning?: boolean;
  
  /**
   * DynamoDB billing mode
   */
  billingMode?: dynamodb.BillingMode;
  
  /**
   * DynamoDB table names
   */
  tableNames?: {
    processing?: string;
    validation?: string;
    courses?: string;
  };
}

export class DataStorage extends Construct {
  public readonly buckets: {
    rawCatalogs: s3.Bucket;
    processedResults: s3.Bucket;
    humanReviewAssets: s3.Bucket;
  };
  
  public readonly tables: {
    processingState: dynamodb.Table;
    validationResults: dynamodb.Table;
    courseCatalog: dynamodb.Table;
  };
  
  constructor(scope: Construct, id: string, props: DataStorageProps = {}) {
    super(scope, id);
    
    const {
      environment = 'development',
      enableVersioning = true,
      billingMode = dynamodb.BillingMode.PAY_PER_REQUEST,
      tableNames = {
        processing: 'processing-state',
        validation: 'validation-results',
        courses: 'course-catalog',
      },
    } = props;
    
    // Create S3 buckets
    this.buckets = this.createS3Buckets(environment, enableVersioning);
    
    // Create DynamoDB tables
    this.tables = this.createDynamoDBTables(environment, billingMode, tableNames);
  }
  
  private createS3Buckets(environment: string, enableVersioning: boolean) {
    // Raw catalogs bucket - where original PDF catalogs are stored
    const rawCatalogs = new s3.Bucket(this, 'RawCatalogsBucket', {
      bucketName: `deepseek-ocr-raw-catalogs-${environment}`,
      versioned: enableVersioning,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY, // For development - change to RETAIN for production
      
      // Lifecycle rules for cost optimization
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: Duration.days(30),
        },
        {
          id: 'ArchiveOldObjects',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(90),
            },
          ],
        },
      ],
    });
    
    // Processed results bucket - OCR output and structured data
    const processedResults = new s3.Bucket(this, 'ProcessedResultsBucket', {
      bucketName: `deepseek-ocr-processed-results-${environment}`,
      versioned: enableVersioning,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      
      // CORS for web access if needed
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 300,
        },
      ],
      
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });
    
    // Human review assets bucket - A2I templates, worker UI assets, etc.
    const humanReviewAssets = new s3.Bucket(this, 'HumanReviewAssetsBucket', {
      bucketName: `deepseek-ocr-human-review-assets-${environment}`,
      versioned: false, // Not needed for static assets
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      
      // Public read access for A2I worker UI
      publicReadAccess: false, // We'll configure specific access via IAM
    });
    
    return {
      rawCatalogs,
      processedResults,
      humanReviewAssets,
    };
  }
  
  private createDynamoDBTables(
    environment: string,
    billingMode: dynamodb.BillingMode,
    tableNames: NonNullable<DataStorageProps['tableNames']>
  ) {
    // Processing state table - tracks OCR job status and metadata
    const processingState = new dynamodb.Table(this, 'ProcessingStateTable', {
      tableName: `deepseek-ocr-${tableNames.processing}-${environment}`,
      billingMode,
      partitionKey: {
        name: 'jobId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      
      // TTL for automatic cleanup of old job records
      timeToLiveAttribute: 'ttl',
      
      removalPolicy: RemovalPolicy.DESTROY,
    });
    
    // Add Global Secondary Indexes
    processingState.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });
    
    processingState.addGlobalSecondaryIndex({
      indexName: 'CatalogIndex',
      partitionKey: {
        name: 'catalogId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });
    
    // Validation results table - stores A2I human review results
    const validationResults = new dynamodb.Table(this, 'ValidationResultsTable', {
      tableName: `deepseek-ocr-${tableNames.validation}-${environment}`,
      billingMode,
      partitionKey: {
        name: 'humanLoopName',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    
    // Add Global Secondary Indexes for validation results
    validationResults.addGlobalSecondaryIndex({
      indexName: 'JobIndex',
      partitionKey: {
        name: 'jobId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });
    
    validationResults.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'reviewStatus',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
    });
    
    // Course catalog table - final validated course data
    const courseCatalog = new dynamodb.Table(this, 'CourseCatalogTable', {
      tableName: `deepseek-ocr-${tableNames.courses}-${environment}`,
      billingMode,
      partitionKey: {
        name: 'courseId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'version',
        type: dynamodb.AttributeType.NUMBER,
      },
      
      // No TTL for production course data
      removalPolicy: RemovalPolicy.RETAIN, // Keep production data
      
      // Point-in-time recovery for production data
      pointInTimeRecovery: environment === 'production',
      
      // Stream for real-time processing
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    
    // Add Global Secondary Indexes for course catalog
    courseCatalog.addGlobalSecondaryIndex({
      indexName: 'InstitutionIndex',
      partitionKey: {
        name: 'institutionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'courseNumber',
        type: dynamodb.AttributeType.STRING,
      },
    });
    
    courseCatalog.addGlobalSecondaryIndex({
      indexName: 'CatalogIndex',
      partitionKey: {
        name: 'catalogId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'courseNumber',
        type: dynamodb.AttributeType.STRING,
      },
    });
    
    courseCatalog.addGlobalSecondaryIndex({
      indexName: 'SubjectIndex',
      partitionKey: {
        name: 'subject',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'courseNumber',
        type: dynamodb.AttributeType.STRING,
      },
    });
    
    return {
      processingState,
      validationResults,
      courseCatalog,
    };
  }
  
  /**
   * Create IAM policies for accessing the storage resources
   */
  public createAccessPolicies() {
    // Policy for ECS tasks to access S3 buckets
    const s3AccessPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
          ],
          resources: [
            `${this.buckets.rawCatalogs.bucketArn}/*`,
            `${this.buckets.processedResults.bucketArn}/*`,
            `${this.buckets.humanReviewAssets.bucketArn}/*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:ListBucket',
          ],
          resources: [
            this.buckets.rawCatalogs.bucketArn,
            this.buckets.processedResults.bucketArn,
            this.buckets.humanReviewAssets.bucketArn,
          ],
        }),
      ],
    });
    
    // Policy for accessing DynamoDB tables
    const dynamoDbAccessPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          resources: [
            this.tables.processingState.tableArn,
            this.tables.validationResults.tableArn,
            this.tables.courseCatalog.tableArn,
            // Include GSI ARNs
            `${this.tables.processingState.tableArn}/index/*`,
            `${this.tables.validationResults.tableArn}/index/*`,
            `${this.tables.courseCatalog.tableArn}/index/*`,
          ],
        }),
      ],
    });
    
    return {
      s3AccessPolicy,
      dynamoDbAccessPolicy,
    };
  }
  
  /**
   * Add bucket notifications for processing triggers
   */
  public addBucketNotifications() {
    // Example: Add S3 event notification to trigger processing
    // This would typically trigger a Lambda or Step Function
    /*
    this.buckets.rawCatalogs.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processingLambda),
      { prefix: 'catalogs/', suffix: '.pdf' }
    );
    */
  }
}
