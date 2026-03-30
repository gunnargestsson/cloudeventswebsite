# Enterprise Open Mirror Architecture

> **Version:** 1.0 — 2026-03-30
> **Status:** Proposal — Ready for Review

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Enterprise Requirements](#enterprise-requirements)
4. [Architecture Overview](#architecture-overview)
5. [Multi-Source BC Configuration](#multi-source-bc-configuration)
6. [Multi-Landing-Zone Configuration](#multi-landing-zone-configuration)
7. [Component Design](#component-design)
   - [Control Plane — Azure SQL Database](#control-plane--azure-sql-database)
   - [Orchestrator — Azure Durable Functions](#orchestrator--azure-durable-functions)
   - [Worker — Azure Functions (Isolated)](#worker--azure-functions-isolated)
   - [Management API — Azure Functions HTTP](#management-api--azure-functions-http)
   - [Admin Portal — Azure Static Web App](#admin-portal--azure-static-web-app)
8. [Data Flow](#data-flow)
9. [Security Design](#security-design)
10. [Performance & Scalability](#performance--scalability)
11. [Reliability & Recovery](#reliability--recovery)
12. [Logging, Monitoring & Alerting](#logging-monitoring--alerting)
13. [Networking & Infrastructure](#networking--infrastructure)
14. [Infrastructure as Code](#infrastructure-as-code)
15. [Cost Estimate](#cost-estimate)
16. [Migration Path from Current System](#migration-path-from-current-system)
17. [Operation Reference](#operation-reference)
18. [Glossary](#glossary)

---

## Executive Summary

The current Open Mirror system runs as a browser-driven scheduler backed by a single
Azure Static Web App (SWA) Azure Function. It works well for a single BC environment
mirroring to a single ADLS Gen2 / Fabric landing zone, but it has structural
limitations that prevent enterprise-grade adoption:

- **Browser dependency** — the scheduler only runs while a browser tab is open.
- **Single BC source** — credentials and configuration are scoped to one BC tenant/environment.
- **Single landing zone** — one ADLS Gen2 destination for all tables.
- **No persistent orchestration** — if the SWA function cold-starts or the browser sleeps, in-flight mirrors can stall.
- **No centralised monitoring** — logs are session-scoped in the browser; no persistent history.
- **No alerting** — failures are only visible to the user who happens to have the page open.

This document proposes an enterprise-grade Azure architecture that:

1. Runs mirrors on a **server-side schedule** independent of any browser.
2. Supports **multiple BC sources** (tenants, environments, companies).
3. Supports **multiple landing zones** (ADLS Gen2, OneLake / Fabric).
4. Provides **enterprise security** (Key Vault, Managed Identity, RBAC, private networking).
5. Delivers **reliability** (Durable Functions orchestration, automatic retries, dead-letter handling).
6. Includes **centralised logging, monitoring, and alerting** (Application Insights, Azure Monitor, Action Groups).

The BC Cloud Events API endpoint (`api.businesscentral.dynamics.com`) remains unchanged —
no modifications to the BC extension are required.

---

## Current State Analysis

### Architecture (as-is)

```
┌─────────────────────┐       ┌──────────────────────┐       ┌─────────────────────┐
│  Browser (SPA)      │──────▶│  Azure SWA Function   │──────▶│  BC Cloud Events    │
│  bc-open-mirror.html│       │  /api/mirror          │       │  API (per company)  │
│  - Scheduler        │       │  - Auth (OAuth2 CC)   │       └─────────────────────┘
│  - Polling          │       │  - Queue submit/poll  │
│  - Log display      │       │  - CSV stream→ADLS    │──────▶┌─────────────────────┐
└─────────────────────┘       │  - Config CRUD        │       │  ADLS Gen2 / Fabric │
                              │  - DDL upload         │       │  Landing Zone       │
                              └──────────────────────┘       └─────────────────────┘
```

### Limitations

| Area | Current State | Enterprise Gap |
|------|--------------|----------------|
| Scheduling | Browser `setTimeout` per table | No server-side scheduling; tab must stay open |
| BC Sources | Single tenant/env via `x-bc-*` headers | Cannot manage multiple BC environments centrally |
| Landing Zones | Single ADLS connection stored in BC | Cannot route different tables to different destinations |
| Secrets | AES-256-GCM encrypted in BC storage + env vars | No Key Vault, no rotation, encryption key in app settings |
| Orchestration | Frontend polling + in-memory transfer state | Transfer state lost on cold start; no durable workflows |
| Retries | 5 consecutive errors → auto-disable | No structured retry policy with exponential backoff |
| Monitoring | Browser console + session log panel | No persistent logs, no metrics, no dashboards |
| Alerting | None | No email/Teams/PagerDuty notifications on failure |
| Networking | Public endpoints everywhere | No VNet integration, no private endpoints |
| IaC | Manual deployment | No Bicep/Terraform, no repeatable provisioning |

---

## Enterprise Requirements

### Functional

| ID | Requirement |
|----|------------|
| F-1 | Mirror BC tables incrementally (modified + deleted records) to ADLS Gen2 / OneLake landing zones on a configurable schedule without any browser dependency |
| F-2 | Support **N BC sources** — each source is a unique (tenant, environment, company) tuple with its own OAuth2 credentials |
| F-3 | Support **M landing zones** — each landing zone is an ADLS Gen2 or OneLake endpoint with its own service principal or managed identity |
| F-4 | Each table mirror configuration binds one BC source → one landing zone, with independent field selection, table view filter, interval, and activation toggle |
| F-5 | Chunked export support — handle tables with millions of records via `continueFromRecordId` continuation tokens |
| F-6 | DDL (_metadata.json) auto-generated and uploaded on activation following the Fabric Open Mirroring schema format |
| F-7 | Integration timestamp tracking per table config via the BC `Cloud Events Integration` table |
| F-8 | Management API for CRUD operations on sources, landing zones, and table configurations |
| F-9 | Admin portal (web UI) for configuration and monitoring |
| F-10 | Initialise / reset a table mirror (reverse all integration timestamps, next run exports from the beginning) |

### Non-Functional

| ID | Requirement |
|----|------------|
| NF-1 | All secrets in Azure Key Vault; zero secrets in app settings or source code |
| NF-2 | Managed Identity for all Azure service ↔ service communication |
| NF-3 | VNet integration with private endpoints for Key Vault, Storage, SQL |
| NF-4 | Structured logging to Application Insights with correlation IDs |
| NF-5 | Azure Monitor alerts on mirror failures, SLA breaches, and quota limits |
| NF-6 | Horizontal scalability — multiple table mirrors execute concurrently |
| NF-7 | Automatic retries with exponential backoff for transient BC and ADLS errors |
| NF-8 | 99.9% uptime for the orchestration layer (matches Azure Functions SLA) |
| NF-9 | Infrastructure as Code (Bicep) for repeatable deployment |
| NF-10 | Support for dev/staging/prod environments via parameter files |

---

## Architecture Overview

```
                                  ┌──────────────────────────────────────────────┐
                                  │             Azure Resource Group              │
                                  │         rg-openmirror-{env}-{region}          │
                                  │                                              │
                                  │  ┌────────────────────────────────────────┐  │
                                  │  │     Azure SQL Database (Serverless)    │  │
                                  │  │         Control Plane / Config         │  │
   ┌────────────┐                 │  │  - BC Sources (credentials→KV refs)   │  │
   │  Admin UI   │──HTTPS────────▶│  │  - Landing Zones (credentials→KV)    │  │
   │  (SWA)      │                │  │  - Table Configs (per source×zone)    │  │
   └────────────┘                 │  │  - Run History & Error Tracking       │  │
                                  │  │  - Integration Timestamps             │  │
         ┌───────────────────────▶│  └────────────────────────────────────────┘  │
         │                        │                    ▲                          │
         │                        │                    │ reads config             │
         │                        │  ┌─────────────────┴──────────────────────┐  │
         │    Management API      │  │   Azure Durable Functions (Isolated)   │  │
         │    (HTTP Triggers)     │  │              Orchestrator               │  │
         │                        │  │                                        │  │
         │                        │  │  Timer Trigger (every 1 min)           │  │
         │                        │  │    └─ Scan due tables                  │  │
         │                        │  │    └─ Start orchestration per table    │  │
         │                        │  │                                        │  │
         │                        │  │  Orchestrator Function                 │  │
         │                        │  │    1. Submit BC queue (CSV + Deleted)  │  │
         │                        │  │    2. Poll BC queue status             │  │
         │                        │  │    3. Stream CSV → ADLS                │  │
         │                        │  │    4. Update integration timestamp     │  │
         │                        │  │    5. Handle continuation chunks       │  │
         │                        │  │    6. Update run history               │  │
         │                        │  │                                        │  │
         │                        │  └───────┬──────────────┬─────────────────┘  │
         │                        │          │              │                     │
         │                        │          ▼              ▼                     │
         │                        │  ┌──────────┐  ┌───────────────┐             │
         │                        │  │ BC Cloud  │  │ ADLS Gen2 /   │             │
         │                        │  │ Events API│  │ OneLake       │             │
         │                        │  │ (N sources│  │ (M zones)     │             │
         │                        │  └──────────┘  └───────────────┘             │
         │                        │                                              │
         │                        │  ┌────────────────────────────────────────┐  │
         │                        │  │         Azure Key Vault                │  │
         │                        │  │  - BC client secrets per source       │  │
         │                        │  │  - ADLS client secrets per zone       │  │
         │                        │  │  - SQL connection string              │  │
         │                        │  │  - Encryption keys                    │  │
         │                        │  └────────────────────────────────────────┘  │
         │                        │                                              │
         │                        │  ┌────────────────────────────────────────┐  │
         │                        │  │       Application Insights             │  │
         │                        │  │  - Structured traces & metrics        │  │
         │                        │  │  - Dependency tracking                │  │
         │                        │  │  - Custom events & dashboards         │  │
         │                        │  └────────────────────────────────────────┘  │
         │                        │                                              │
         │                        │  ┌────────────────────────────────────────┐  │
         │                        │  │       Azure Monitor / Action Groups    │  │
         │                        │  │  - Alert rules on failures            │  │
         │                        │  │  - Email / Teams / PagerDuty          │  │
         │                        │  └────────────────────────────────────────┘  │
         │                        └──────────────────────────────────────────────┘
```

---

## Multi-Source BC Configuration

Each "BC Source" represents a unique Business Central endpoint that the mirror system
can pull data from.

### Data Model

```
BCSource
├── sourceId          UNIQUEIDENTIFIER (PK)
├── displayName       NVARCHAR(200)        -- e.g. "Contoso Production"
├── tenantId          NVARCHAR(100)        -- Entra tenant ID or domain
├── environment       NVARCHAR(100)        -- BC environment name
├── companyId         UNIQUEIDENTIFIER     -- BC company GUID
├── companyName       NVARCHAR(200)        -- Display only
├── kvSecretName      NVARCHAR(200)        -- Key Vault secret name for client credentials
├── isEnabled         BIT
├── createdAt         DATETIME2
└── updatedAt         DATETIME2
```

### Credential Storage

Each BC source requires an OAuth2 client credentials grant (service principal).
The `clientId` and `clientSecret` are stored as a **single JSON secret** in Azure Key Vault:

```
Key Vault Secret: "bc-source-{sourceId}"
Value: { "clientId": "...", "clientSecret": "..." }
```

The function app accesses Key Vault via **Managed Identity** — no connection strings
or access keys in app settings.

### How It Works

1. Admin creates a BC Source in the Admin Portal, providing tenant, environment, company,
   and service principal credentials.
2. The Management API stores the credential in Key Vault and saves the reference
   (`kvSecretName`) in Azure SQL.
3. When the orchestrator processes a table mirror, it reads the source's
   `kvSecretName`, fetches the credential from Key Vault, and acquires a BC access token.
4. Token caching uses the same pattern as today (in-memory with expiry-based eviction),
   scoped per Function instance.

### Adding a New BC Source

```
POST /api/admin/sources
{
  "displayName": "Contoso Production",
  "tenantId": "contoso.onmicrosoft.com",
  "environment": "production",
  "companyId": "a1b2c3d4-...",
  "companyName": "Contoso Ltd.",
  "clientId": "sp-client-id",
  "clientSecret": "sp-client-secret"
}
```

The API:
1. Validates input (URL format, GUID format, non-empty strings).
2. Stores `{ clientId, clientSecret }` in Key Vault as `bc-source-{newGuid}`.
3. Inserts a row in `BCSource` with `kvSecretName = "bc-source-{newGuid}"`.
4. Returns the new `sourceId`.

---

## Multi-Landing-Zone Configuration

Each "Landing Zone" represents an ADLS Gen2 or OneLake destination where mirrored
CSV files and DDL metadata are written.

### Data Model

```
LandingZone
├── zoneId            UNIQUEIDENTIFIER (PK)
├── displayName       NVARCHAR(200)        -- e.g. "Fabric Lakehouse - Finance"
├── mirrorUrl         NVARCHAR(2000)       -- https://account.dfs.core.windows.net/container/path
├── zoneType          NVARCHAR(50)         -- 'ADLSGen2' | 'OneLake'
├── authMethod        NVARCHAR(50)         -- 'ServicePrincipal' | 'ManagedIdentity'
├── tenantId          NVARCHAR(100)        -- Entra tenant for SP auth
├── kvSecretName      NVARCHAR(200)        -- KV secret name (null if ManagedIdentity)
├── isVerified        BIT
├── isEnabled         BIT
├── createdAt         DATETIME2
└── updatedAt         DATETIME2
```

### Authentication Options

| Method | When to Use | Credential |
|--------|-------------|-----------|
| **Service Principal** | Cross-tenant, external Fabric workspace | `clientId` + `clientSecret` in Key Vault |
| **Managed Identity** | Same-tenant ADLS / OneLake | Function App's system-assigned identity; no secret needed |

For Managed Identity auth, the Function App's identity is granted **Storage Blob Data Contributor**
on the target storage account. No Key Vault secret is required.

### Verification

Before a landing zone can be used, the system verifies connectivity:

- **ADLS Gen2:** list filesystem + check directory existence (same as current `verifyMirrorConnection`).
- **OneLake / Fabric:** acquire a storage token + validate URL pattern (Fabric may reject some probe operations).

---

## Component Design

### Control Plane — Azure SQL Database

**Why Azure SQL?** The current system stores config as JSON blobs in BC's `Cloud Events Storage`
table. This works for single-source/single-zone but cannot support relational queries across
multiple sources, zones, and table configs with run history. Azure SQL Serverless provides:

- Relational schema with foreign keys and indexes.
- Efficient queries for the timer trigger ("give me all table configs that are due").
- Run history with queryable error details.
- Auto-pause after inactivity to minimise cost.

#### Schema

```sql
-- BC Sources
CREATE TABLE BCSource (
    sourceId         UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    displayName      NVARCHAR(200)    NOT NULL,
    tenantId         NVARCHAR(100)    NOT NULL,
    environment      NVARCHAR(100)    NOT NULL DEFAULT 'production',
    companyId        UNIQUEIDENTIFIER NOT NULL,
    companyName      NVARCHAR(200)    NULL,
    kvSecretName     NVARCHAR(200)    NOT NULL,
    isEnabled        BIT              NOT NULL DEFAULT 1,
    createdAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Landing Zones
CREATE TABLE LandingZone (
    zoneId           UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    displayName      NVARCHAR(200)    NOT NULL,
    mirrorUrl        NVARCHAR(2000)   NOT NULL,
    zoneType         NVARCHAR(50)     NOT NULL DEFAULT 'ADLSGen2',
    authMethod       NVARCHAR(50)     NOT NULL DEFAULT 'ServicePrincipal',
    tenantId         NVARCHAR(100)    NULL,
    kvSecretName     NVARCHAR(200)    NULL,
    isVerified       BIT              NOT NULL DEFAULT 0,
    isEnabled        BIT              NOT NULL DEFAULT 1,
    createdAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Table Mirror Configurations
CREATE TABLE TableConfig (
    configId             UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    sourceId             UNIQUEIDENTIFIER NOT NULL REFERENCES BCSource(sourceId),
    zoneId               UNIQUEIDENTIFIER NOT NULL REFERENCES LandingZone(zoneId),
    tableId              INT              NOT NULL,
    tableName            NVARCHAR(200)    NOT NULL,
    dataPerCompany       BIT              NOT NULL DEFAULT 1,
    fieldNumbers         NVARCHAR(MAX)    NULL,  -- JSON array: [1, 2, 5, 7]
    tableView            NVARCHAR(2000)   NULL,  -- WHERE(Blocked=CONST( ))
    intervalMinutes      INT              NOT NULL DEFAULT 60,
    isActive             BIT              NOT NULL DEFAULT 0,
    maxChunkRecords      INT              NULL,  -- NULL = BC default
    continueFromRecordId NVARCHAR(100)    NULL,
    errorCount           INT              NOT NULL DEFAULT 0,
    lastError            NVARCHAR(MAX)    NULL,
    lastSuccessAt        DATETIME2        NULL,
    disabledReason       NVARCHAR(500)    NULL,
    nextRunAt            DATETIME2        NULL,
    createdAt            DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    updatedAt            DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),

    INDEX IX_TableConfig_DueRun (isActive, nextRunAt) WHERE isActive = 1
);

-- Integration Timestamps (mirrors BC's Cloud Events Integration table)
CREATE TABLE IntegrationTimestamp (
    configId         UNIQUEIDENTIFIER NOT NULL REFERENCES TableConfig(configId),
    timestampValue   DATETIME2        NOT NULL,
    isReversed       BIT              NOT NULL DEFAULT 0,
    createdAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),

    PRIMARY KEY (configId, timestampValue)
);

-- Run History
CREATE TABLE MirrorRun (
    runId            UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    configId         UNIQUEIDENTIFIER NOT NULL REFERENCES TableConfig(configId),
    orchestrationId  NVARCHAR(200)    NULL,  -- Durable Functions instance ID
    status           NVARCHAR(50)     NOT NULL,  -- 'Running','Completed','Failed','Skipped','Cancelled'
    startedAt        DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    completedAt      DATETIME2        NULL,
    mirroredRecords  INT              NULL,
    deletedRecords   INT              NULL,
    csvBytes         BIGINT           NULL,
    deletedCsvBytes  BIGINT           NULL,
    csvFilePath      NVARCHAR(2000)   NULL,
    deletedFilePath  NVARCHAR(2000)   NULL,
    bcQueueId        UNIQUEIDENTIFIER NULL,
    bcDeletedQueueId UNIQUEIDENTIFIER NULL,
    errorMessage     NVARCHAR(MAX)    NULL,
    durationMs       INT              NULL,
    isContinuation   BIT              NOT NULL DEFAULT 0,

    INDEX IX_MirrorRun_Config_Status (configId, status, startedAt DESC)
);

-- Retention: auto-purge run history older than 90 days
-- Implemented via a scheduled SQL Agent job or a timer-triggered function
```

### Orchestrator — Azure Durable Functions

The orchestrator replaces the browser-based scheduler with a server-side durable
workflow engine.

#### Timer Trigger (Scheduler)

Runs every **60 seconds**. Queries Azure SQL for table configs where:

```sql
SELECT c.configId, c.sourceId, c.zoneId, c.tableName, c.intervalMinutes,
       c.continueFromRecordId, c.fieldNumbers, c.tableView, c.dataPerCompany,
       s.tenantId, s.environment, s.companyId, s.kvSecretName AS sourceKvSecret,
       z.mirrorUrl, z.zoneType, z.authMethod, z.tenantId AS zoneTenantId,
       z.kvSecretName AS zoneKvSecret
FROM   TableConfig c
JOIN   BCSource s ON c.sourceId = s.sourceId
JOIN   LandingZone z ON c.zoneId = z.zoneId
WHERE  c.isActive = 1
  AND  s.isEnabled = 1
  AND  z.isEnabled = 1
  AND  z.isVerified = 1
  AND  c.nextRunAt <= SYSUTCDATETIME()
  AND  c.disabledReason IS NULL
```

For each due table config, the timer trigger starts a new **Durable Orchestration**
instance (if one is not already running for that config).

#### Orchestration Flow

Each table mirror runs as an independent Durable Functions orchestration:

```
MirrorTableOrchestrator(configId)
│
├── Activity: AcquireCredentials
│   ├── Read BC source credentials from Key Vault
│   ├── Read landing zone credentials from Key Vault (if SP auth)
│   └── Acquire BC OAuth2 access token
│
├── Activity: SubmitBCQueues
│   ├── Submit CSV.Records.Get to BC queue API
│   ├── Submit CSV.DeletedRecords.Get to BC queue API
│   └── Return { queueId, deletedQueueId }
│
├── Loop: PollBCQueueStatus  (with durable timer between polls)
│   ├── Activity: CheckQueueStatus(queueId)
│   ├── Activity: CheckQueueStatus(deletedQueueId)
│   ├── If both completed → break
│   ├── If error/cancelled → handle (retry or fail)
│   └── CreateTimer(adaptive interval: 10s → 30s → 60s)
│
├── Activity: StreamCSVToADLS
│   ├── Stream BC CSV response → ADLS in 4MB chunks
│   ├── Stream deleted records CSV → ADLS
│   └── Return { mirroredRecords, deletedRecords, filePaths, bcTimestamp }
│
├── Activity: UpdateIntegrationTimestamp
│   ├── Write confirmed BC timestamp to BC Cloud Events Integration
│   └── Update local IntegrationTimestamp table
│
├── Decision: Continuation?
│   ├── If continueFromRecordId returned → update config, restart orchestration
│   └── If no continuation → proceed to completion
│
├── Activity: UpdateRunHistory
│   ├── Insert MirrorRun record
│   ├── Update TableConfig.nextRunAt
│   ├── Reset errorCount on success
│   └── Update lastSuccessAt
│
└── End
```

#### Error Handling in Orchestration

```
On transient error (HTTP 429, 500, 502, 503, 504):
  → Retry with exponential backoff: 10s, 30s, 90s, 270s (max 4 retries)

On BC queue error (task cancelled, JSON error response):
  → Retry BC queue submission once
  → If retry fails → mark run as Failed, increment errorCount

On ADLS upload error:
  → Reverse integration timestamp in BC
  → Retry upload once
  → If retry fails → mark run as Failed

On 5 consecutive failures:
  → Set disabledReason = "Auto-disabled after 5 consecutive errors"
  → Send alert notification
  → Require manual re-enablement via admin portal
```

#### Why Durable Functions?

| Requirement | Durable Functions Advantage |
|-------------|---------------------------|
| Long-running exports (hours) | Orchestrations survive function restarts and scale-ins |
| Polling BC queue with waits | `CreateTimer` does not consume compute resources while waiting |
| Resume after failure | Orchestration state is checkpointed; replays from last checkpoint |
| Concurrency control | Singleton orchestration per configId prevents duplicate runs |
| Visibility | Built-in status endpoint shows orchestration state |

### Worker — Azure Functions (Isolated)

The activity functions that do the actual work:

| Activity Function | Responsibility |
|-------------------|---------------|
| `AcquireCredentials` | Read Key Vault secrets, acquire BC token |
| `SubmitBCQueues` | POST to BC queue API (fire-and-forget) |
| `CheckQueueStatus` | GET BC queue status (one poll iteration) |
| `StreamCSVToADLS` | Streaming download from BC → chunked upload to ADLS |
| `UpdateIntegrationTimestamp` | Write timestamp to BC + local SQL |
| `ReverseIntegrationTimestamp` | Reverse timestamp on failure |
| `UploadDDL` | Generate and upload _metadata.json to landing zone |
| `UpdateRunHistory` | Write run result to MirrorRun table |

### Management API — Azure Functions HTTP

RESTful API for the admin portal and external integrations:

```
# BC Sources
GET    /api/admin/sources
POST   /api/admin/sources
GET    /api/admin/sources/{sourceId}
PUT    /api/admin/sources/{sourceId}
DELETE /api/admin/sources/{sourceId}
POST   /api/admin/sources/{sourceId}/test   -- test BC connectivity

# Landing Zones
GET    /api/admin/zones
POST   /api/admin/zones
GET    /api/admin/zones/{zoneId}
PUT    /api/admin/zones/{zoneId}
DELETE /api/admin/zones/{zoneId}
POST   /api/admin/zones/{zoneId}/verify     -- verify ADLS connectivity

# Table Configurations
GET    /api/admin/configs
POST   /api/admin/configs
GET    /api/admin/configs/{configId}
PUT    /api/admin/configs/{configId}
DELETE /api/admin/configs/{configId}
POST   /api/admin/configs/{configId}/activate
POST   /api/admin/configs/{configId}/deactivate
POST   /api/admin/configs/{configId}/run-now
POST   /api/admin/configs/{configId}/initialize
POST   /api/admin/configs/{configId}/stop

# BC Metadata (proxied to BC Cloud Events API)
GET    /api/admin/sources/{sourceId}/tables
GET    /api/admin/sources/{sourceId}/tables/{tableRef}/fields

# Run History & Monitoring
GET    /api/admin/configs/{configId}/runs
GET    /api/admin/runs/{runId}
GET    /api/admin/dashboard                 -- aggregated stats

# Health
GET    /api/health
```

### Admin Portal — Azure Static Web App

A modern web UI (successor to the current `bc-open-mirror.html`) that allows
administrators to:

- Manage BC sources and landing zones.
- Configure table mirrors with the field picker.
- Monitor active orchestrations and run history.
- View logs, errors, and performance metrics.
- Trigger manual runs and initializations.

The Admin Portal is an Azure Static Web App that calls the Management API.
Authentication: Azure AD / Entra ID with role-based access (Admin, Viewer).

---

## Data Flow

### Normal Mirror Run (Happy Path)

```
1. Timer trigger fires (every 60s)
2. Query SQL: SELECT due table configs
3. For each due config:
   a. Start Durable Orchestration (singleton per configId)
   b. AcquireCredentials → Key Vault → BC Token
   c. SubmitBCQueues:
      - POST CSV.Records.Get → BC queue (returns queueId)
      - POST CSV.DeletedRecords.Get → BC queue (returns deletedQueueId)
   d. PollBCQueueStatus (adaptive: 10s/30s/60s):
      - POST queues({id})/Microsoft.NAV.GetStatus
      - HTTP 201 = running, 200 = completed, 204 = deleted
   e. StreamCSVToADLS:
      - GET queue record → extract data URL
      - Stream BC CSV → ADLS file client (4MB chunks)
      - Parallel stream for deleted records CSV
   f. UpdateIntegrationTimestamp:
      - Write BC-confirmed timestamp to Cloud Events Integration table
      - Write to local SQL IntegrationTimestamp table
   g. UpdateRunHistory:
      - Insert MirrorRun with status='Completed'
      - Update TableConfig.nextRunAt = now + intervalMinutes
      - Reset errorCount = 0
```

### Chunked Export (Large Tables)

```
1. Normal flow through step (e)
2. BC response includes continueFromRecordId (non-null GUID)
3. StreamCSVToADLS uploads the partial chunk
4. Skip timestamp update (chunk is partial)
5. Update TableConfig.continueFromRecordId in SQL
6. Set nextRunAt = now + 10 seconds (immediate follow-up)
7. Next timer tick starts new orchestration for the continuation
8. Repeat until continueFromRecordId is null (final chunk)
9. Final chunk: update timestamp, clear continueFromRecordId
```

### Failure & Recovery

```
Transient BC Error (HTTP 429/5xx):
  → Durable retry policy: 4 attempts, exponential backoff
  → If all retries exhausted → mark run Failed, increment errorCount

ADLS Upload Failure:
  → Reverse BC integration timestamp
  → Retry upload once
  → If still failing → mark run Failed

Orchestration Crash (Function App restart):
  → Durable Functions replay from last checkpoint
  → BC queue state is still available (24h TTL)
  → Resume polling or re-submit

5 Consecutive Failures:
  → Auto-disable table config
  → Alert via Action Group (email/Teams)
  → Requires manual intervention (admin portal)
```

---

## Security Design

### Identity & Access Management

| Component | Identity | Access |
|-----------|---------|--------|
| Function App → Key Vault | System-assigned Managed Identity | Key Vault Secrets User role |
| Function App → Azure SQL | System-assigned Managed Identity | Entra-based SQL auth (no password) |
| Function App → ADLS (same tenant) | System-assigned Managed Identity | Storage Blob Data Contributor |
| Function App → ADLS (cross-tenant) | Service Principal (from Key Vault) | Storage Blob Data Contributor on target |
| Function App → BC API | Service Principal (from Key Vault) | BC API scope via client credentials |
| Admin Portal → Management API | Entra ID user token | Custom RBAC roles |
| Admin Portal → SWA | Entra ID authentication | Built-in SWA auth |

### Secret Management

| Secret | Storage | Rotation Strategy |
|--------|---------|-------------------|
| BC client credentials (per source) | Key Vault secret `bc-source-{id}` | Manual or automated via Key Vault rotation policy |
| ADLS client credentials (per zone) | Key Vault secret `adls-zone-{id}` | Manual or automated |
| SQL connection | Managed Identity (no secret) | N/A |
| Encryption key (legacy compat) | Key Vault secret `mirror-encryption-key` | Rotate with Key Vault policy |

### Network Security

```
┌─────────────────────────────────────────────────────┐
│  VNet: vnet-openmirror-{env}                        │
│  Address: 10.0.0.0/16                               │
│                                                      │
│  ┌──────────────────────────┐                        │
│  │ Subnet: snet-functions    │                        │
│  │ 10.0.1.0/24              │                        │
│  │ - Function App (VNet Int) │                        │
│  │ - NSG: allow outbound 443 │                        │
│  └──────────┬───────────────┘                        │
│             │                                        │
│  ┌──────────▼───────────────┐                        │
│  │ Subnet: snet-private-eps  │                        │
│  │ 10.0.2.0/24              │                        │
│  │ Private Endpoints:        │                        │
│  │  - Key Vault             │                        │
│  │  - Azure SQL             │                        │
│  │  - Storage (if same sub) │                        │
│  └──────────────────────────┘                        │
└─────────────────────────────────────────────────────┘

Outbound through VNet:
  - api.businesscentral.dynamics.com (BC API) → HTTPS 443
  - login.microsoftonline.com (Entra ID) → HTTPS 443
  - *.dfs.core.windows.net (ADLS) → HTTPS 443
  - *.dfs.fabric.microsoft.com (OneLake) → HTTPS 443
```

### RBAC Roles (Admin Portal)

| Role | Permissions |
|------|------------|
| **Mirror Admin** | Full CRUD on sources, zones, configs. Start/stop runs. View all data. |
| **Mirror Operator** | View configs. Run Now, Initialize, Start/Stop. Cannot modify credentials. |
| **Mirror Viewer** | Read-only access to configs, run history, and dashboards. |

### Data Protection

- BC credentials encrypted at rest in Key Vault (AES-256, HSM-backed).
- ADLS credentials encrypted at rest in Key Vault.
- SQL Database encrypted at rest (TDE) and in transit (TLS 1.2).
- All API traffic over HTTPS (TLS 1.2 minimum).
- No secrets in logs — `Application Insights` configured to scrub sensitive headers.

---

## Performance & Scalability

### Concurrency Model

| Dimension | Limit | Rationale |
|-----------|-------|-----------|
| Concurrent orchestrations (global) | 50 | Prevent overwhelming BC API rate limits |
| Concurrent orchestrations per BC source | 10 | BC API has per-tenant throttling |
| Concurrent ADLS uploads per zone | 10 | Avoid ADLS throttling (10,000 ops/sec) |
| Max chunk size (streaming) | 4 MB | ADLS Gen2 append limit |
| Max poll duration per queue | 12 hours | Handle very large table exports |
| Adaptive poll intervals | 10s → 30s → 60s | Reduce unnecessary API calls |

### Scale Configuration

```json
// host.json — Durable Functions
{
  "version": "2.0",
  "extensions": {
    "durableTask": {
      "maxConcurrentActivityFunctions": 20,
      "maxConcurrentOrchestratorFunctions": 50
    }
  }
}
```

### Function App Plan

**Recommended:** Azure Functions **Premium (EP1)** or **Flex Consumption**

| Plan | Pros | Cons |
|------|------|------|
| **Consumption** | Cheapest at low volume | Cold starts, 10-min timeout, no VNet |
| **Premium EP1** | Always-warm instances, VNet integration, no timeout | Higher base cost (~€140/mo) |
| **Flex Consumption** | Per-execution pricing with always-ready instances, VNet | Preview (as of 2026), limited regions |

**Recommendation:** Start with **Premium EP1** for production reliability, VNet support,
and no execution time limits. Use Consumption for dev/test.

### BC API Rate Limiting

BC enforces API rate limits per tenant. The orchestrator respects these by:

1. Limiting concurrent orchestrations per BC source (configurable, default 10).
2. Using adaptive polling intervals (reduces calls during long exports).
3. Honouring HTTP 429 responses with `Retry-After` header.
4. The Durable Functions retry policy includes 429 as a retryable status.

---

## Reliability & Recovery

### Failure Modes & Mitigations

| Failure Mode | Detection | Mitigation |
|-------------|-----------|-----------|
| BC API unavailable | HTTP 5xx, timeout | Retry with exponential backoff (4 attempts) |
| BC API rate limited | HTTP 429 | Honour Retry-After header; reduce concurrency |
| BC queue task cancelled | Status 204 / status code 0 | Retry queue submission once; if still cancelled → fail |
| BC queue JSON error | datacontenttype = json | Retry queue task via RetryTask action; if still error → fail |
| ADLS write failure | Azure SDK exception | Reverse integration timestamp → retry once → fail |
| Function App restart | Durable Functions replay | Automatic recovery from last checkpoint |
| SQL Database unavailable | Connection timeout | Auto-retry (built-in ADO.NET resilience); orchestration waits |
| Key Vault unavailable | HTTP 5xx | Retry; cached tokens survive short outages |
| Network partition | Various timeouts | VNet + private endpoints reduce blast radius |

### Dead Letter Handling

Runs that fail after all retries are recorded in `MirrorRun` with `status = 'Failed'`
and full error details. The admin portal shows a "Failed Runs" view with:

- Error message and stack trace.
- BC queue IDs for investigation.
- One-click "Retry" button to re-trigger the orchestration.
- "Initialize" button to reset timestamps and start from scratch.

### SLA Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Mirrors completed on schedule | 99.5% | (successful + skipped runs) / scheduled runs |
| Mirror data freshness | < 2× interval | Time since last successful run per table |
| Management API availability | 99.9% | Azure Monitor uptime check |
| Alert notification latency | < 5 min | Time from failure detection to notification |

---

## Logging, Monitoring & Alerting

### Structured Logging

All components log to **Application Insights** with a consistent schema:

```json
{
  "timestamp": "2026-03-30T10:15:30.000Z",
  "severity": "Information",
  "message": "Mirror run completed",
  "properties": {
    "correlationId": "run-guid",
    "configId": "config-guid",
    "sourceId": "source-guid",
    "zoneId": "zone-guid",
    "tableName": "Customer",
    "tableId": 18,
    "mirroredRecords": 1250,
    "deletedRecords": 3,
    "durationMs": 45200,
    "csvBytes": 2457600,
    "operation": "MirrorTableOrchestrator"
  }
}
```

### Custom Metrics

| Metric | Type | Description |
|--------|------|------------|
| `mirror.runs.completed` | Counter | Successful mirror runs |
| `mirror.runs.failed` | Counter | Failed mirror runs |
| `mirror.runs.skipped` | Counter | Skipped runs (no records) |
| `mirror.records.mirrored` | Counter | Total records mirrored |
| `mirror.records.deleted` | Counter | Total deleted records processed |
| `mirror.duration.ms` | Histogram | Run duration in milliseconds |
| `mirror.csv.bytes` | Histogram | CSV data volume per run |
| `mirror.queue.poll.count` | Counter | BC queue poll iterations |
| `mirror.errors.transient` | Counter | Transient errors (retried) |
| `mirror.errors.permanent` | Counter | Permanent errors (failed) |

### Dashboards

**Azure Workbook: "Open Mirror Operations"**

- **Overview:** Total runs today/week, success rate, active orchestrations.
- **Per-Source:** Runs by BC source, error rates, latency.
- **Per-Zone:** Upload volume, file counts, ADLS latency.
- **Per-Table:** Records mirrored, duration trends, error history.
- **Failures:** Recent failed runs with error details and retry status.

### Alert Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Mirror failure | Any run with status = 'Failed' | Sev 2 (Warning) | Email + Teams |
| Auto-disabled table | disabledReason is set | Sev 1 (Error) | Email + Teams + PagerDuty |
| High error rate | > 20% failure rate in 1 hour | Sev 1 (Error) | Email + Teams |
| Stale mirror | No successful run for > 3× interval | Sev 2 (Warning) | Email |
| ADLS write failures | > 5 ADLS errors in 15 min | Sev 2 (Warning) | Email + Teams |
| BC API rate limited | > 10 HTTP 429 responses in 5 min | Sev 3 (Info) | Email |
| Orchestration stuck | Running > 6 hours | Sev 2 (Warning) | Email + Teams |
| Function App unhealthy | Health check fails 3 times | Sev 1 (Error) | Email + Teams + PagerDuty |

### Log Retention

| Tier | Retention | Storage |
|------|-----------|---------|
| Application Insights (hot) | 90 days | Log Analytics workspace |
| Archive (cold) | 2 years | Export to Storage Account (Parquet) |
| Run history (SQL) | 90 days | Auto-purge via scheduled job |

---

## Networking & Infrastructure

### Resource Layout

```
Subscription: sub-openmirror-prod
└── Resource Group: rg-openmirror-prod-westeurope
    ├── Azure Functions App (Premium EP1)
    │   ├── System-assigned Managed Identity
    │   ├── VNet Integration → snet-functions
    │   └── Application Settings (no secrets — all from Key Vault refs)
    │
    ├── Azure Functions Storage Account (internal, for Durable Functions state)
    │   └── Private Endpoint → snet-private-eps
    │
    ├── Azure SQL Database (Serverless, Gen5, 2 vCores)
    │   ├── Entra-only authentication
    │   └── Private Endpoint → snet-private-eps
    │
    ├── Azure Key Vault (Standard)
    │   ├── RBAC-based access (no access policies)
    │   └── Private Endpoint → snet-private-eps
    │
    ├── Application Insights
    │   └── Connected to Log Analytics workspace
    │
    ├── Log Analytics Workspace
    │
    ├── Azure Static Web App (Admin Portal)
    │   └── Entra ID authentication
    │
    ├── VNet: vnet-openmirror-prod
    │   ├── snet-functions (10.0.1.0/24) — Function App VNet Integration
    │   └── snet-private-eps (10.0.2.0/24) — Private Endpoints
    │
    ├── Action Group: ag-openmirror-alerts
    │   ├── Email receivers
    │   ├── Teams webhook
    │   └── PagerDuty (optional)
    │
    └── Monitor Alert Rules (as defined above)
```

### DNS

Private DNS zones for private endpoints:

- `privatelink.vaultcore.azure.net` (Key Vault)
- `privatelink.database.windows.net` (SQL)
- `privatelink.blob.core.windows.net` (Storage)
- `privatelink.dfs.core.windows.net` (Storage DFS)

---

## Infrastructure as Code

All resources are provisioned via **Bicep** with environment-specific parameter files.

### File Structure

```
infra/
├── main.bicep                   -- Top-level orchestration
├── main.bicepparam              -- Production parameters
├── main.dev.bicepparam          -- Dev parameters
├── modules/
│   ├── vnet.bicep               -- VNet, subnets, NSGs
│   ├── keyVault.bicep           -- Key Vault + private endpoint
│   ├── sql.bicep                -- Azure SQL + private endpoint
│   ├── functionApp.bicep        -- Function App + VNet integration
│   ├── staticWebApp.bicep       -- Admin Portal SWA
│   ├── appInsights.bicep        -- App Insights + Log Analytics
│   ├── monitoring.bicep         -- Alert rules + action groups
│   └── storage.bicep            -- Function App storage + private endpoint
└── scripts/
    ├── deploy.sh                -- az deployment group create wrapper
    └── seed-sql.sql             -- Initial schema creation
```

### Deployment

```bash
# Deploy to production
az deployment group create \
  --resource-group rg-openmirror-prod-westeurope \
  --template-file infra/main.bicep \
  --parameters infra/main.bicepparam

# Deploy to dev
az deployment group create \
  --resource-group rg-openmirror-dev-westeurope \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam
```

### CI/CD Pipeline

```yaml
# GitHub Actions
on:
  push:
    branches: [main]
    paths: ['infra/**', 'api/**', 'admin-portal/**']

jobs:
  deploy-infra:
    runs-on: ubuntu-latest
    steps:
      - uses: azure/login@v2
      - run: az deployment group create ...

  deploy-functions:
    needs: deploy-infra
    runs-on: ubuntu-latest
    steps:
      - run: npm ci && npm run build
      - uses: azure/functions-action@v1

  deploy-portal:
    needs: deploy-infra
    runs-on: ubuntu-latest
    steps:
      - uses: azure/static-web-apps-deploy@v1
```

---

## Cost Estimate

Monthly cost estimate for a production deployment mirroring 30 tables across 3 BC
sources to 2 landing zones, with an average interval of 60 minutes.

| Resource | SKU | Estimated Monthly Cost (EUR) |
|----------|-----|------------------------------|
| Azure Functions (Premium EP1) | 1 instance, auto-scale to 3 | €140–420 |
| Azure SQL Database (Serverless) | Gen5, 2 vCores, auto-pause | €30–80 |
| Azure Key Vault (Standard) | ~50 secrets, ~100K operations/mo | €5 |
| Application Insights | ~5 GB ingestion/mo | €10 |
| Log Analytics Workspace | 5 GB/mo, 90-day retention | €10 |
| Storage Account (Functions runtime) | LRS, minimal usage | €2 |
| VNet + Private Endpoints | 3 private endpoints | €22 |
| Static Web App (Admin Portal) | Standard tier | €8 |
| **Total** | | **~€230–560** |

**Cost optimization notes:**
- Use Consumption plan for dev/test (~€20–50/mo).
- SQL Serverless auto-pauses after 1 hour of inactivity (saves ~60% on dev).
- Application Insights sampling reduces ingestion costs for high-volume scenarios.

---

## Migration Path from Current System

### Phase 1: Infrastructure (Week 1–2)

1. Provision Azure resources via Bicep.
2. Create SQL schema.
3. Deploy Function App with Management API.
4. Deploy Admin Portal (SWA).

### Phase 2: Core Orchestration (Week 3–4)

5. Implement Durable Functions orchestrator.
6. Implement activity functions (reuse existing `api/mirror/index.js` logic).
7. Implement timer trigger for scheduling.
8. End-to-end testing with a single BC source and landing zone.

### Phase 3: Multi-Source & Multi-Zone (Week 5–6)

9. Implement BC Source CRUD + Key Vault integration.
10. Implement Landing Zone CRUD + verification.
11. Admin Portal: source and zone management UI.
12. Test with multiple sources and zones.

### Phase 4: Monitoring & Hardening (Week 7–8)

13. Configure Application Insights telemetry.
14. Create Azure Monitor alert rules.
15. Build operations dashboard (Workbook).
16. Load testing with 50+ concurrent mirrors.
17. Security review and penetration testing.

### Phase 5: Migration & Cutover (Week 9–10)

18. Import existing table configs from BC Cloud Events Storage into SQL.
19. Verify all mirrors run correctly on the new system.
20. Decommission browser scheduler (disable scheduler UI or redirect to admin portal).
21. Update documentation and runbooks.

### Backward Compatibility

During migration, the existing browser-based system continues to work unchanged.
The new system reads the same BC Cloud Events Integration timestamps, so table mirrors
can be migrated one at a time without data loss or duplicate exports.

---

## Operation Reference

Detailed documentation for every operation in the current Open Mirror system, including
request/response formats, backend and frontend code, sequence diagrams, and enterprise
upgrade paths.

### Authentication & Connection

| # | Operation | Description |
|---|-----------|-------------|
| 01 | [Authentication](operations/01-authentication.md) | OAuth2 client credentials token acquisition with in-memory caching |
| 02 | [Save Mirror Connection](operations/02-save-mirror-connection.md) | Encrypt and store ADLS Gen2/OneLake connection credentials |
| 03 | [Verify Mirror Connection](operations/03-verify-mirror-connection.md) | Probe ADLS endpoint to validate credentials and permissions |

### Table Discovery & Configuration

| # | Operation | Description |
|---|-----------|-------------|
| 04 | [List Tables](operations/04-list-tables.md) | Retrieve BC table catalog via Help.Tables.Get |
| 05 | [Get Table Fields](operations/05-get-table-fields.md) | Fetch field definitions for a table via Help.Fields.Get |
| 06 | [Save Table Configs](operations/06-save-table-configs.md) | Persist array of table mirror configurations |
| 07 | [Activate Table](operations/07-activate-table.md) | Upload DDL metadata and enable a table for mirroring |
| 08 | [Deactivate Table](operations/08-deactivate-table.md) | Disable a table (soft disable, config preserved) |
| 09 | [Initialize Table](operations/09-initialize-table.md) | Reset sync timestamps for a full re-export |

### Mirror Execution

| # | Operation | Description |
|---|-----------|-------------|
| 10 | [Start Queue Mirror](operations/10-start-queue-mirror.md) | Submit CSV.Records.Get and CSV.DeletedRecords.Get queues to BC |
| 11 | [Check Queue Status](operations/11-check-queue-status.md) | Poll BC queue task status (running/completed/deleted/error) |
| 12 | [Cancel Queue Mirror](operations/12-cancel-queue-mirror.md) | Cancel a running BC queue task via CancelTask |
| 13 | [Retry Queue Mirror](operations/13-retry-queue-mirror.md) | Retry a failed BC queue task via RetryTask |
| 14 | [Start Transfer](operations/14-start-transfer.md) | Stream CSV data from BC to ADLS Gen2 (fire-and-forget) |
| 15 | [Check Transfer Status](operations/15-check-transfer-status.md) | Poll transfer progress and completion |

### Orchestration

| # | Operation | Description |
|---|-----------|-------------|
| 16 | [Run Table Now](operations/16-run-table-now.md) | Full 4-step orchestrated mirror run (queue → poll → transfer → poll) |
| 17 | [Browser Scheduler](operations/17-browser-scheduler.md) | Per-table timers, concurrency control, wake detection |
| 18 | [Resume Pending Queues](operations/18-resume-pending-queues.md) | Recover in-flight mirrors after page reload or browser sleep |

---

## Glossary

| Term | Definition |
|------|-----------|
| **BC Source** | A unique Business Central endpoint: (tenant, environment, company) + OAuth2 credentials |
| **Landing Zone** | An ADLS Gen2 or OneLake destination where mirrored CSV files are written |
| **Table Config** | A mirror configuration binding one table from one BC Source to one Landing Zone |
| **Mirror Run** | A single execution of the mirror process for one table config |
| **Integration Timestamp** | The BC-confirmed `SystemModifiedAt` value from the last successful run, used as `startDateTime` for the next incremental fetch |
| **DDL** | `_metadata.json` — the Fabric Open Mirroring schema definition uploaded on table activation |
| **Continuation** | A chunked export where BC returns `continueFromRecordId` indicating more records are pending |
| **Orchestration** | A Durable Functions workflow instance managing one mirror run end-to-end |
| **Activity** | A single unit of work within an orchestration (e.g., submit queue, stream CSV) |
| **Queue** | A BC Cloud Events queue entry (async task) for CSV generation |
