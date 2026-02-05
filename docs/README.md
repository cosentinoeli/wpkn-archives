# Frontend Application

This is the Winamp 5-inspired frontend for the WPKN Radio Archives.

## Cache Busting

When updating CSS or JavaScript files, increment the version number in `index.html`:

```html
<link rel="stylesheet" href="styles.css?v=1.3">
<script src="config.js?v=1.3"></script>
<script src="app.js?v=1.3"></script>
```

This forces browsers to fetch fresh files instead of using cached versions.

## Configuration

The application dynamically loads its configuration from the `/v1/config` API endpoint. No hardcoded credentials or secrets are stored in this repository.

Configuration values include:
- **API_ENDPOINT**: API Gateway URL
- **BUCKET_NAME**: S3 bucket for recordings
- **IDENTITY_POOL_ID**: Cognito Identity Pool for authenticated S3 access
- **REGION**: AWS region

## Local Development

To run locally:

```bash
cd frontend
python -m http.server 8080
```

Then open http://localhost:8080 in your browser.

For local development, the config.js will automatically fetch from the production API endpoint to get configuration values.

## Deployment

The frontend can be deployed to:
- S3 + CloudFront for production hosting
- GitHub Pages
- Any static web hosting service

When deployed behind the same API Gateway domain, it will automatically use relative URLs for the `/v1/config` endpoint.

## Security

- No AWS credentials or secrets are stored in the code
- All configuration is fetched dynamically from a secure API endpoint
- CORS is properly configured on the API Gateway
- Cognito Identity Pool provides unauthenticated access to S3 recordings
