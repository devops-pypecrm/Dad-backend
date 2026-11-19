// import { Pool, PoolConfig } from 'pg';
// import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client';
import { registerMoneyMiddleware } from '../utils/moneyConversion';
import { setCurrencyDb } from '../services/currencyService';

const globalForPrisma = global as unknown as {
    prisma: PrismaClient;
    cronPrisma: PrismaClient;
};

// Main API Prisma client — uses connection_limit from DATABASE_URL
if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient();
    registerMoneyMiddleware(globalForPrisma.prisma); // money stored in USD, shown in the org's currency
    setCurrencyDb(globalForPrisma.prisma);
}

// Dedicated Cron Prisma client — limited to 3 connections so crons
// never starve the API request connection pool.
if (!globalForPrisma.cronPrisma) {
    const baseUrl = process.env.DATABASE_URL || '';
    // Strip existing connection_limit / pool_timeout params and re-apply our own
    const cleanUrl = baseUrl
        .replace(/[&?]connection_limit=\d+/g, '')
        .replace(/[&?]pool_timeout=\d+/g, '');
    const sep = cleanUrl.includes('?') ? '&' : '?';
    const cronUrl = `${cleanUrl}${sep}connection_limit=3&pool_timeout=60`;

    globalForPrisma.cronPrisma = new PrismaClient({
        datasources: { db: { url: cronUrl } }
    });
}

export const prisma = globalForPrisma.prisma;
export const cronPrisma = globalForPrisma.cronPrisma;
export default prisma;
