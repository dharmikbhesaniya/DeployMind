import type { ServiceDefinition } from './service.definition.types.js';

export const BUILTIN_SERVICE_DEFINITIONS: Record<string, ServiceDefinition> = {
  clickhouse: {
    id: 'def_clickhouse_24',
    serviceType: 'clickhouse',
    aliases: ['clickhouse-server', 'ch'],
    category: 'sql',
    version: '24.8',
    image: 'clickhouse/clickhouse-server:latest',
    defaultInternalPort: 8123,
    environment: {
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/var/lib/clickhouse' },
      { nameSuffix: 'logs', containerPath: '/var/log/clickhouse-server' },
    ],
    healthCheck: {
      type: 'http',
      httpPath: '/ping',
      port: 8123,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'database_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Create Tenant Database & Grants',
        action: 'exec_in_container',
        command: [
          'clickhouse-client',
          '--query',
          'CREATE DATABASE IF NOT EXISTS ${DATABASE}; CREATE USER IF NOT EXISTS ${USERNAME} IDENTIFIED BY \'${PASSWORD}\'; GRANT ALL ON ${DATABASE}.* TO ${USERNAME};',
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Drop Tenant Database & User',
        action: 'exec_in_container',
        command: [
          'clickhouse-client',
          '--query',
          'DROP DATABASE IF EXISTS ${DATABASE}; DROP USER IF EXISTS ${USERNAME};',
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'http://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}',
      envMappings: {
        CLICKHOUSE_URL: '${URI}',
        CLICKHOUSE_HOST: '${HOST}',
        CLICKHOUSE_PORT: '${PORT}',
        CLICKHOUSE_USER: '${USERNAME}',
        CLICKHOUSE_PASSWORD: '${PASSWORD}',
        CLICKHOUSE_DATABASE: '${DATABASE}',
        CLICKHOUSE_DB: '${DATABASE}',
      },
    },
    securityPolicy: {
      disallowPrivileged: true,
      disallowHostMounts: true,
    },
    provenance: {
      source: 'builtin',
      generatedAt: 1728500000000,
    },
  },

  neo4j: {
    id: 'def_neo4j_5',
    serviceType: 'neo4j',
    aliases: ['neo4j-db', 'graphdb'],
    category: 'graph',
    version: '5.23',
    image: 'neo4j:5-community',
    defaultInternalPort: 7687,
    environment: {
      NEO4J_AUTH: 'neo4j/${ADMIN_PASSWORD}',
      NEO4J_PLUGINS: '["apoc"]',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/data' },
      { nameSuffix: 'logs', containerPath: '/logs' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 7687,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'user_per_tenant',
      maxTenantsPerInstance: 30,
    },
    provisionWorkflow: [
      {
        name: 'Create Scoped Neo4j User',
        action: 'exec_in_container',
        command: [
          'cypher-shell',
          '-u',
          'neo4j',
          '-p',
          '${ADMIN_PASSWORD}',
          'CREATE USER ${USERNAME} SET PASSWORD \'${PASSWORD}\' CHANGE NOT REQUIRED;',
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Drop Scoped Neo4j User',
        action: 'exec_in_container',
        command: [
          'cypher-shell',
          '-u',
          'neo4j',
          '-p',
          '${ADMIN_PASSWORD}',
          'DROP USER ${USERNAME} IF EXISTS;',
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'bolt://${HOST}:${PORT}',
      envMappings: {
        NEO4J_URI: '${URI}',
        NEO4J_URL: 'bolt://${USERNAME}:${PASSWORD}@${HOST}:${PORT}',
        NEO4J_HOST: '${HOST}',
        NEO4J_PORT: '${PORT}',
        NEO4J_USERNAME: '${USERNAME}',
        NEO4J_USER: '${USERNAME}',
        NEO4J_PASSWORD: '${PASSWORD}',
      },
    },
    securityPolicy: {
      disallowPrivileged: true,
      disallowHostMounts: true,
    },
    provenance: {
      source: 'builtin',
      generatedAt: 1728500000000,
    },
  },

  kafka: {
    id: 'def_kafka_3',
    serviceType: 'kafka',
    aliases: ['apache-kafka', 'event-broker'],
    category: 'broker',
    version: '3.7',
    image: 'apache/kafka:latest',
    defaultInternalPort: 9092,
    environment: {
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://${HOST}:9092',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/var/lib/kafka/data' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 9092,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'vhost_or_namespace_per_tenant',
      maxTenantsPerInstance: 100,
    },
    provisionWorkflow: [
      {
        name: 'Provision Project Initial Topic',
        action: 'exec_in_container',
        command: [
          '/opt/kafka/bin/kafka-topics.sh',
          '--bootstrap-server',
          'localhost:9092',
          '--create',
          '--if-not-exists',
          '--topic',
          '${TENANT_TOPIC}',
          '--partitions',
          '1',
          '--replication-factor',
          '1',
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Delete Project Initial Topic',
        action: 'exec_in_container',
        command: [
          '/opt/kafka/bin/kafka-topics.sh',
          '--bootstrap-server',
          'localhost:9092',
          '--delete',
          '--if-exists',
          '--topic',
          '${TENANT_TOPIC}',
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: '${HOST}:${PORT}',
      envMappings: {
        KAFKA_BROKERS: '${URI}',
        KAFKA_BOOTSTRAP_SERVERS: '${URI}',
        KAFKA_HOST: '${HOST}',
        KAFKA_PORT: '${PORT}',
        KAFKA_DEFAULT_TOPIC: '${TENANT_TOPIC}',
        KAFKA_TOPIC_PREFIX: '${TENANT_PREFIX}',
      },
    },
    securityPolicy: {
      disallowPrivileged: true,
      disallowHostMounts: true,
    },
    provenance: {
      source: 'builtin',
      generatedAt: 1728500000000,
    },
  },

  qdrant: {
    id: 'def_qdrant_1',
    serviceType: 'qdrant',
    aliases: ['vector-db', 'qdrant-vector'],
    category: 'vector',
    version: '1.9',
    image: 'qdrant/qdrant:latest',
    defaultInternalPort: 6333,
    volumes: [
      { nameSuffix: 'storage', containerPath: '/qdrant/storage' },
    ],
    healthCheck: {
      type: 'http',
      httpPath: '/readyz',
      port: 6333,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'database_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [],
    deprovisionWorkflow: [],
    connectionContract: {
      uriTemplate: 'http://${HOST}:${PORT}',
      envMappings: {
        QDRANT_URL: '${URI}',
        QDRANT_HOST: '${HOST}',
        QDRANT_PORT: '${PORT}',
        QDRANT_COLLECTION: '${TENANT_PREFIX}',
      },
    },
    securityPolicy: {
      disallowPrivileged: true,
      disallowHostMounts: true,
    },
    provenance: {
      source: 'builtin',
      generatedAt: 1728500000000,
    },
  },
};
