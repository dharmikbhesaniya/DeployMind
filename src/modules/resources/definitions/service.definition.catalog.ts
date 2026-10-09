import type { ServiceDefinition } from './service.definition.types.js';

export const BUILTIN_SERVICE_DEFINITIONS: Record<string, ServiceDefinition> = {
  postgres: {
    id: 'def_postgres_16',
    serviceType: 'postgres',
    aliases: ['postgresql', 'pg'],
    category: 'sql',
    version: '16-alpine',
    image: 'postgres:16-alpine',
    defaultInternalPort: 5432,
    environment: {
      POSTGRES_USER: 'deploymind_admin',
      POSTGRES_PASSWORD: '${ADMIN_PASSWORD}',
      POSTGRES_DB: 'postgres',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/var/lib/postgresql/data' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 5432,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'database_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Create PostgreSQL Isolated Role and Database',
        action: 'exec_in_container',
        command: [
          'psql',
          '-U',
          'deploymind_admin',
          '-d',
          'postgres',
          '-c',
          "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${USERNAME}') THEN CREATE USER ${USERNAME} WITH PASSWORD '${PASSWORD}'; END IF; END $$; SELECT 'CREATE DATABASE ${DATABASE} OWNER ${USERNAME}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DATABASE}')\\gexec REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC; GRANT ALL PRIVILEGES ON DATABASE ${DATABASE} TO ${USERNAME};",
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Drop PostgreSQL Database and Role',
        action: 'exec_in_container',
        command: [
          'psql',
          '-U',
          'deploymind_admin',
          '-d',
          'postgres',
          '-c',
          'DROP DATABASE IF EXISTS ${DATABASE}; DROP USER IF EXISTS ${USERNAME};',
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'postgresql://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}',
      envMappings: {
        DATABASE_URL: '${URI}',
        POSTGRES_URL: '${URI}',
        PGHOST: '${HOST}',
        PGPORT: '${PORT}',
        PGUSER: '${USERNAME}',
        PGPASSWORD: '${PASSWORD}',
        PGDATABASE: '${DATABASE}',
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

  redis: {
    id: 'def_redis_7',
    serviceType: 'redis',
    aliases: ['keydb', 'cache'],
    category: 'cache',
    version: '7-alpine',
    image: 'redis:7-alpine',
    defaultInternalPort: 6379,
    environment: {},
    volumes: [
      { nameSuffix: 'data', containerPath: '/data' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 6379,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'key_prefix_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Configure Redis ACL User with Key Prefix Restriction',
        action: 'exec_in_container',
        command: [
          'redis-cli',
          '-a',
          '${ADMIN_PASSWORD}',
          'ACL',
          'SETUSER',
          '${USERNAME}',
          'on',
          '>${PASSWORD}',
          '~${TENANT_PREFIX}:*',
          '+@all',
          '-@dangerous',
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Delete Redis ACL User',
        action: 'exec_in_container',
        command: [
          'redis-cli',
          '-a',
          '${ADMIN_PASSWORD}',
          'ACL',
          'DELUSER',
          '${USERNAME}',
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'redis://${USERNAME}:${PASSWORD}@${HOST}:${PORT}',
      envMappings: {
        REDIS_URL: '${URI}',
        REDIS_HOST: '${HOST}',
        REDIS_PORT: '${PORT}',
        REDIS_PASSWORD: '${PASSWORD}',
        REDIS_USER: '${USERNAME}',
        REDIS_KEY_PREFIX: '${TENANT_PREFIX}:',
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

  mysql: {
    id: 'def_mysql_11',
    serviceType: 'mysql',
    aliases: ['mariadb', 'mysql-server'],
    category: 'sql',
    version: '11',
    image: 'mariadb:11',
    defaultInternalPort: 3306,
    environment: {
      MARIADB_ROOT_PASSWORD: '${ADMIN_PASSWORD}',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/var/lib/mysql' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 3306,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'database_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Create MySQL Isolated Database and User',
        action: 'exec_in_container',
        command: [
          'mariadb',
          '-u',
          'root',
          '-p${ADMIN_PASSWORD}',
          '-e',
          "CREATE DATABASE IF NOT EXISTS `${DATABASE}`; CREATE USER IF NOT EXISTS '${USERNAME}'@'%' IDENTIFIED BY '${PASSWORD}'; GRANT ALL PRIVILEGES ON `${DATABASE}`.* TO '${USERNAME}'@'%'; FLUSH PRIVILEGES;",
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Drop MySQL Database and User',
        action: 'exec_in_container',
        command: [
          'mariadb',
          '-u',
          'root',
          '-p${ADMIN_PASSWORD}',
          '-e',
          "DROP DATABASE IF EXISTS `${DATABASE}`; DROP USER IF EXISTS '${USERNAME}'@'%'; FLUSH PRIVILEGES;",
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'mysql://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}',
      envMappings: {
        MYSQL_URL: '${URI}',
        DATABASE_URL: '${URI}',
        MYSQL_HOST: '${HOST}',
        MYSQL_PORT: '${PORT}',
        MYSQL_DATABASE: '${DATABASE}',
        MYSQL_USER: '${USERNAME}',
        MYSQL_PASSWORD: '${PASSWORD}',
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

  mongodb: {
    id: 'def_mongo_7',
    serviceType: 'mongodb',
    aliases: ['mongo', 'document-db'],
    category: 'nosql',
    version: '7',
    image: 'mongo:7',
    defaultInternalPort: 27017,
    environment: {
      MONGO_INITDB_ROOT_USERNAME: 'deploymind_root',
      MONGO_INITDB_ROOT_PASSWORD: '${ADMIN_PASSWORD}',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/data/db' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 27017,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'database_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Create MongoDB Scoped User',
        action: 'exec_in_container',
        command: [
          'mongosh',
          '-u',
          'deploymind_root',
          '-p',
          '${ADMIN_PASSWORD}',
          '--authenticationDatabase',
          'admin',
          '--eval',
          "db.getSiblingDB('${DATABASE}').createUser({ user: '${USERNAME}', pwd: '${PASSWORD}', roles: [{ role: 'readWrite', db: '${DATABASE}' }] })",
        ],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Drop MongoDB User and Database',
        action: 'exec_in_container',
        command: [
          'mongosh',
          '-u',
          'deploymind_root',
          '-p',
          '${ADMIN_PASSWORD}',
          '--authenticationDatabase',
          'admin',
          '--eval',
          "db.getSiblingDB('${DATABASE}').dropUser('${USERNAME}'); db.getSiblingDB('${DATABASE}').dropDatabase();",
        ],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'mongodb://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}?authSource=${DATABASE}',
      envMappings: {
        MONGODB_URI: '${URI}',
        MONGO_URL: '${URI}',
        MONGO_HOST: '${HOST}',
        MONGO_PORT: '${PORT}',
        MONGO_DATABASE: '${DATABASE}',
        MONGO_USER: '${USERNAME}',
        MONGO_PASSWORD: '${PASSWORD}',
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

  rabbitmq: {
    id: 'def_rabbitmq_3',
    serviceType: 'rabbitmq',
    aliases: ['amqp', 'message-broker'],
    category: 'broker',
    version: '3.13',
    image: 'rabbitmq:3.13-management-alpine',
    defaultInternalPort: 5672,
    environment: {
      RABBITMQ_DEFAULT_USER: 'deploymind_admin',
      RABBITMQ_DEFAULT_PASS: '${ADMIN_PASSWORD}',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/var/lib/rabbitmq' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 5672,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'vhost_or_namespace_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Create RabbitMQ Isolated Virtual Host',
        action: 'exec_in_container',
        command: ['rabbitmqctl', 'add_vhost', 'vhost_${TENANT_PREFIX}'],
      },
      {
        name: 'Create Scoped RabbitMQ User',
        action: 'exec_in_container',
        command: ['rabbitmqctl', 'add_user', '${USERNAME}', '${PASSWORD}'],
      },
      {
        name: 'Assign User Permissions on Virtual Host',
        action: 'exec_in_container',
        command: ['rabbitmqctl', 'set_permissions', '-p', 'vhost_${TENANT_PREFIX}', '${USERNAME}', '.*', '.*', '.*'],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Delete RabbitMQ User and Virtual Host',
        action: 'exec_in_container',
        command: ['rabbitmqctl', 'delete_user', '${USERNAME}'],
        ignoreFailure: true,
      },
      {
        name: 'Delete Virtual Host',
        action: 'exec_in_container',
        command: ['rabbitmqctl', 'delete_vhost', 'vhost_${TENANT_PREFIX}'],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'amqp://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/vhost_${TENANT_PREFIX}',
      envMappings: {
        AMQP_URL: '${URI}',
        RABBITMQ_URL: '${URI}',
        RABBITMQ_HOST: '${HOST}',
        RABBITMQ_PORT: '${PORT}',
        RABBITMQ_VHOST: 'vhost_${TENANT_PREFIX}',
        RABBITMQ_USER: '${USERNAME}',
        RABBITMQ_PASSWORD: '${PASSWORD}',
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

  minio: {
    id: 'def_minio_s3',
    serviceType: 'minio',
    aliases: ['s3', 'object-storage', 'blob-storage'],
    category: 'object_storage',
    version: 'latest',
    image: 'minio/minio:RELEASE.2024-05-10T01-41-38Z',
    defaultInternalPort: 9000,
    environment: {
      MINIO_ROOT_USER: 'deploymind_admin',
      MINIO_ROOT_PASSWORD: '${ADMIN_PASSWORD}',
    },
    volumes: [
      { nameSuffix: 'data', containerPath: '/data' },
    ],
    healthCheck: {
      type: 'tcp',
      port: 9000,
      timeoutSeconds: 5,
    },
    multiTenancy: {
      supported: true,
      isolationStrategy: 'bucket_per_tenant',
      maxTenantsPerInstance: 50,
    },
    provisionWorkflow: [
      {
        name: 'Initialize MinIO mc Client Alias',
        action: 'exec_in_container',
        command: ['mc', 'alias', 'set', 'local', 'http://127.0.0.1:9000', 'deploymind_admin', '${ADMIN_PASSWORD}'],
      },
      {
        name: 'Create Tenant Bucket',
        action: 'exec_in_container',
        command: ['mc', 'mb', '--ignore-existing', 'local/bucket-${TENANT_PREFIX}'],
      },
      {
        name: 'Create Scoped MinIO User',
        action: 'exec_in_container',
        command: ['mc', 'admin', 'user', 'add', 'local', '${USERNAME}', '${PASSWORD}'],
      },
      {
        name: 'Attach ReadWrite Policy to Scoped User',
        action: 'exec_in_container',
        command: ['mc', 'admin', 'policy', 'attach', 'local', 'readwrite', '--user', '${USERNAME}'],
      },
    ],
    deprovisionWorkflow: [
      {
        name: 'Remove MinIO User and Bucket',
        action: 'exec_in_container',
        command: ['mc', 'admin', 'user', 'remove', 'local', '${USERNAME}'],
        ignoreFailure: true,
      },
      {
        name: 'Remove Bucket',
        action: 'exec_in_container',
        command: ['mc', 'rb', '--force', 'local/bucket-${TENANT_PREFIX}'],
        ignoreFailure: true,
      },
    ],
    connectionContract: {
      uriTemplate: 'http://${HOST}:${PORT}',
      envMappings: {
        S3_ENDPOINT: 'http://${HOST}:${PORT}',
        S3_BUCKET: 'bucket-${TENANT_PREFIX}',
        AWS_ACCESS_KEY_ID: '${USERNAME}',
        AWS_SECRET_ACCESS_KEY: '${PASSWORD}',
        S3_ACCESS_KEY: '${USERNAME}',
        S3_SECRET_KEY: '${PASSWORD}',
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
    status: 'approved',
  },
};

// Explicitly establish trusted approved status on all built-in catalog definitions
for (const def of Object.values(BUILTIN_SERVICE_DEFINITIONS)) {
  def.status = 'approved';
}
