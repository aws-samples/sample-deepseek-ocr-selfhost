import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';

export interface ApiGatewayProps {
  /**
   * VPC for the VPC Link
   */
  vpc: ec2.IVpc;
  
  /**
   * Application Load Balancer to integrate with
   */
  loadBalancer: elbv2.IApplicationLoadBalancer;
  
  /**
   * Environment name for naming resources
   */
  environment?: string;
  
  /**
   * Whether to enable API keys
   */
  enableApiKeys?: boolean;
  
  /**
   * Usage plan configuration
   */
  usagePlan?: {
    throttleRateLimit?: number;
    throttleBurstLimit?: number;
    quotaLimit?: number;
    quotaPeriod?: apigateway.Period;
  };
}

export class ApiGateway extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly vpcLink: apigateway.VpcLink;
  public apiKey?: apigateway.ApiKey;
  public usagePlan?: apigateway.UsagePlan;
  
  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);
    
    const {
      vpc,
      loadBalancer,
      environment = 'development',
      enableApiKeys = true,
      usagePlan = {
        throttleRateLimit: 100,
        throttleBurstLimit: 200,
        quotaLimit: 10000,
        quotaPeriod: apigateway.Period.DAY,
      },
    } = props;
    
    // Note: Since we're using an internet-facing ALB, we don't need VPC Link
    // VPC Link is only needed for private Network Load Balancers
    this.vpcLink = new apigateway.VpcLink(this, 'VpcLink', {
      description: `VPC Link for DeepSeek OCR ${environment}`,
      vpcLinkName: `deepseek-ocr-vpclink-${environment}`,
      // targets: [loadBalancer], // Commented out since ALB is not supported
    });
    
    // Create CloudWatch log group for API Gateway logs
    const logGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      logGroupName: `/aws/apigateway/deepseek-ocr-${environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    
    // Create REST API
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `deepseek-ocr-api-${environment}`,
      description: `DeepSeek OCR API for ${environment} environment`,
      
      // CORS configuration
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
      
      // Binary media types for file uploads
      binaryMediaTypes: [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/gif',
        'image/bmp',
        'image/tiff',
        'multipart/form-data',
      ],
      
      // Deployment options
      deploy: true,
      deployOptions: {
        stageName: environment,
        throttlingRateLimit: usagePlan.throttleRateLimit,
        throttlingBurstLimit: usagePlan.throttleBurstLimit,
        
        // Enable CloudWatch logging
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          `$requestId $requestTime $httpMethod $resourcePath $status $responseLength $responseLatency $sourceIp "$userAgent"`
        ),
      },
    });
    
    // Create integration with the load balancer
    const integration = new apigateway.Integration({
      type: apigateway.IntegrationType.HTTP_PROXY,
      integrationHttpMethod: 'ANY',
      uri: `http://${loadBalancer.loadBalancerDnsName}/{proxy}`,
      options: {
        vpcLink: this.vpcLink,
        requestParameters: {
          'integration.request.path.proxy': 'method.request.path.proxy',
        },
      },
    });
    
    // Add API resources and methods
    this.createApiResources(integration);
    
    // Create API Key and Usage Plan if enabled
    if (enableApiKeys) {
      this.createApiKeyAndUsagePlan(usagePlan);
    }
    
    // Add custom domain name if needed (commented out for now)
    // this.addCustomDomain();
  }
  
  private createApiResources(integration: apigateway.Integration): void {
    // Health check endpoint
    const health = this.api.root.addResource('health');
    health.addMethod('GET', integration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
    });
    
    // OCR endpoints
    const ocr = this.api.root.addResource('ocr');
    
    // Image OCR endpoint
    const image = ocr.addResource('image');
    image.addMethod('POST', integration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      requestValidator: this.createRequestValidator(),
    });
    
    // PDF OCR endpoint
    const pdf = ocr.addResource('pdf');
    pdf.addMethod('POST', integration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      requestValidator: this.createRequestValidator(),
    });
    
    // Batch OCR endpoint
    const batch = ocr.addResource('batch');
    batch.addMethod('POST', integration, {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      requestValidator: this.createRequestValidator(),
    });
    
    // Add proxy resource to catch all other requests
    const proxy = this.api.root.addProxy({
      defaultIntegration: integration,
      anyMethod: true,
    });
  }
  
  private createRequestValidator(): apigateway.RequestValidator {
    return new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.api,
      requestValidatorName: 'DeepSeekOcrValidator',
      validateRequestBody: true,
      validateRequestParameters: true,
    });
  }
  
  private createApiKeyAndUsagePlan(usagePlanConfig: NonNullable<ApiGatewayProps['usagePlan']>): void {
    // Create API Key
    this.apiKey = new apigateway.ApiKey(this, 'ApiKey', {
      apiKeyName: `deepseek-ocr-key-${this.node.tryGetContext('environment') || 'dev'}`,
      description: 'API Key for DeepSeek OCR service',
      enabled: true,
    });
    
    // Create Usage Plan
    this.usagePlan = new apigateway.UsagePlan(this, 'UsagePlan', {
      name: `deepseek-ocr-usage-plan-${this.node.tryGetContext('environment') || 'dev'}`,
      description: 'Usage plan for DeepSeek OCR API',
      
      // Throttling configuration
      throttle: {
        rateLimit: usagePlanConfig.throttleRateLimit || 100,
        burstLimit: usagePlanConfig.throttleBurstLimit || 200,
      },
      
      // Quota configuration
      quota: {
        limit: usagePlanConfig.quotaLimit || 10000,
        period: usagePlanConfig.quotaPeriod || apigateway.Period.DAY,
      },
      
      // Associate with API stages
      apiStages: [
        {
          api: this.api,
          stage: this.api.deploymentStage,
        },
      ],
    });
    
    // Associate API Key with Usage Plan
    this.usagePlan.addApiKey(this.apiKey);
  }
  
  /**
   * Add a custom domain name to the API Gateway
   * This would typically be used in production environments
   */
  private addCustomDomain(): void {
    // Example implementation - would need actual certificate and domain
    /*
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc123'
    );
    
    const domain = new apigateway.DomainName(this, 'Domain', {
      domainName: 'api.deepseek-ocr.com',
      certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
    });
    
    domain.addBasePathMapping(this.api, {
      basePath: 'v1',
    });
    */
  }
}
