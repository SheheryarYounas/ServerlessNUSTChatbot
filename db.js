const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    user: 'postgres',
    host: 'database-1.cgdco0e6wg3a.us-east-1.rds.amazonaws.com',
    database: "postgres",
    password: 'tqahCJXW3fH9Q3h',
    port: 5432,
    ssl: {
        rejectUnauthorized: false
    },
    max: 40,                         // 10 concurrent connections
    idleTimeoutMillis: 30000,         // Means the connection will be closed after 30 seconds of inactivity
    connectionTimeoutMillis: 20000 , // 20 seconds to establish a connection
    acquireTimeoutMillis: 20000      // 20 seconds to acquire a connection from the pool
});

// Initialize database schema
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 Initializing database schema...');
        
        // Read schema SQL file
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        
        // Split the SQL by semicolons to execute each statement separately
        const statements = schemaSql.split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);
            
        // Execute each statement separately
        for (const statement of statements) {
            await client.query(statement + ';');
        }
        
        console.log('✅ Database schema initialized successfully');
    } catch (err) {
        console.error('❌ Failed to initialize database schema:', err);
    } finally {
        client.release();
    }
}

// Test database connection when the app starts
(async () => {
    try {
        const client = await pool.connect();
        console.log('✅ Successfully connected to PostgreSQL database:', {
            host: pool.options.host,
            database: pool.options.database,
            port: pool.options.port
        });
        client.release();
        
        // Initialize schema after successful connection
        await initializeDatabase();
    } catch (err) {
        console.error('❌ Failed to connect to the database:', err);
    }
})();

pool.on('error', (err, client) => {
    console.error('Unexpected error on idle client', err);
    // Attempt to clean up the client
    if (client) {
        client.release(true); // Force release with error
    }
})

// Add connection success logging
pool.on('connect', () => {
    console.log('New client connected to PostgreSQL');
});

// Add connection release loggingi
pool.on('remove', () => {
    console.log('Client disconnected from PostgreSQL');
});


// Monitor pool statistics periodically
setInterval(() => {
    console.log('Pool statistics:', {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
    });
}, 60000); // Log every minute

module.exports = pool; 