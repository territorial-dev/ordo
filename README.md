# MapPrism Control Plane API

TypeScript + Express backend API for MapPrism, a DAG-based geoprocessing system.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file (copy from `.env.example`):

```bash
API_TOKEN=your-secret-token-here
DATABASE_URL=postgresql://user:password@localhost:5432/mapprism
PORT=3000
```

3. Build the project:

```bash
npm run build
```

4. Start the server:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## API Endpoints

All endpoints (except `/health`) require Bearer token authentication via the `Authorization` header.

### POST /recipes

Register a new recipe.

**Request:**

```json
{
  "name": "example-recipe",
  "version": "1.0.0",
  "definition": {
    "recipe": [
      {
        "id": "step1",
        "type": "PROCESS_TYPE",
        "inputs": ["input_artifact"],
        "outputs": ["output_artifact"],
        "params": {}
      }
    ]
  }
}
```

**Response:**

```json
{
  "id": 1
}
```

### POST /jobs

Create a job from a recipe.

**Request:**

```json
{
  "recipe_id": 1,
  "inputs": {
    "input_artifact": {
      "type": "las",
      "uri": "s3://bucket/path/to/file.las",
      "hash": "abc123",
      "metadata": {}
    }
  }
}
```

**Response:**

```json
{
  "id": 1
}
```

### GET /jobs/:id

Get job status, steps, and artifacts.

**Response:**

```json
{
  "job": {
    "id": 1,
    "recipe_id": 1,
    "status": "pending",
    "created_at": "2024-01-01T00:00:00Z",
    "started_at": null,
    "finished_at": null,
    "error": null
  },
  "steps": [...],
  "artifacts": [...]
}
```

### GET /health

Health check endpoint (no authentication required).

## Architecture

- **Controllers**: Thin request/response handlers
- **Services**: Business logic and database operations
- **Middleware**: Authentication
- **Utils**: Validation utilities
- **Types**: TypeScript interfaces

The API validates recipes, creates jobs, and initializes job steps. Execution is handled by n8n workers that interact directly with the database.
