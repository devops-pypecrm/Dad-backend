import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { getOrgId, getVisibleUserIds } from '../utils/hierarchyUtils';
import { ResponseHandler } from '../utils/apiResponse';
import { logger } from '../utils/logger';

/**
 * Enhanced Global Search Controller
 * Provides unified search across all CRM entities
 */

interface SearchResult {
  id: string;
  type: 'lead' | 'contact' | 'account' | 'opportunity' | 'task';
  title: string;
  subtitle: string;
  description?: string;
  status?: string;
  value?: number;
  assignedTo?: string;
  createdAt: Date;
  url: string;
}

// GET /api/search/global
export const globalSearch = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;
  const organisationId = getOrgId(user);
  const query = req.query.q as string;
  const limit = Math.min(50, Number(req.query.limit) || 20);

  try {
    logger.apiRequest('GET', '/api/search/global', userId, organisationId || undefined, { query, limit });

    if (!organisationId) {
      return ResponseHandler.forbidden(res, 'User not associated with an organisation');
    }

    if (!query || query.trim().length < 2) {
      return ResponseHandler.validationError(res, 'Search query must be at least 2 characters');
    }

    const searchTerm = query.trim();
    const results: SearchResult[] = [];

    // Get visible user IDs based on hierarchy (includes user, subordinates, and branch members)
    const visibleUserIds = await getVisibleUserIds(userId);

    // Get user's branch for additional filtering
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { branchId: true, role: true }
    });

    // Check if user is admin (admins can see all data in their organization)
    const userRole = await prisma.role.findFirst({
      where: {
        OR: [
          { id: currentUser?.role },
          { roleKey: currentUser?.role, organisationId: organisationId },
          { roleKey: currentUser?.role, organisationId: null }
        ]
      }
    });

    const isUserAdmin = userRole?.name === 'Admin' || userRole?.roleKey === 'admin';

    // Build branch filter - only apply if user has a branch and is not admin
    const branchFilter = !isUserAdmin && currentUser?.branchId 
      ? { branchId: currentUser.branchId }
      : {};

    // Search Leads - uses the SAME visibility and matching rules as the Leads list page,
    // otherwise a lead you can open in the list can be missing here (admins/operation
    // executives see every lead; others also see leads they created or unassigned ones).
    const { getLeadVisibilityFilter } = await import('../utils/hierarchyUtils');
    const leadVisibility = await getLeadVisibilityFilter(user, false);
    const searchNoSpace = searchTerm.replace(/\s+/g, '');
    const searchDigits = searchTerm.replace(/\D/g, '');
    // phone is stored WITHOUT the country code, so also try the number with 1-3 leading digits peeled off
    const phoneCandidates = Array.from(new Set(
      [searchTerm, searchNoSpace, searchDigits,
        ...(searchDigits.length > 6 ? [1, 2, 3].map(n => searchDigits.slice(n)) : [])]
        .filter(t => t.length >= 4)
    ));
    const nameParts = searchTerm.split(/\s+/).filter(Boolean);
    const leadSearchOr: any[] = [
      { firstName: { contains: searchTerm, mode: 'insensitive' } },
      { firstName: { contains: searchNoSpace, mode: 'insensitive' } },
      { lastName: { contains: searchTerm, mode: 'insensitive' } },
      { lastName: { contains: searchNoSpace, mode: 'insensitive' } },
      { email: { contains: searchTerm, mode: 'insensitive' } },
      { company: { contains: searchTerm, mode: 'insensitive' } },
      ...phoneCandidates.flatMap(c => ([
        { phone: { contains: c, mode: 'insensitive' as const } },
        { secondaryPhone: { contains: c, mode: 'insensitive' as const } }
      ]))
    ];
    // "Rahul Kumar" - first and last name live in separate columns
    if (nameParts.length >= 2) {
      leadSearchOr.push({
        AND: [
          { firstName: { contains: nameParts[0], mode: 'insensitive' } },
          { lastName: { contains: nameParts.slice(1).join(' '), mode: 'insensitive' } }
        ]
      });
    }
    const leads = await prisma.lead.findMany({
      where: {
        AND: [
          { organisationId, isDeleted: false },
          leadVisibility,
          { OR: leadSearchOr }
        ]
      },
      include: {
        assignedTo: { select: { firstName: true, lastName: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: limit // leads are the main use of search; the final list is trimmed to `limit` below
    });

    leads.forEach(lead => {
      results.push({
        id: lead.id,
        type: 'lead',
        title: `${lead.firstName} ${lead.lastName}`.trim(),
        subtitle: lead.phone || lead.company || lead.email || 'No company',
        description: `${lead.status} • Score: ${lead.leadScore}`,
        status: lead.status,
        assignedTo: lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}` : undefined,
        createdAt: lead.createdAt,
        url: `/leads/${lead.id}`
      });
    });

    // Search Contacts - filtered by hierarchy and branch
    const contacts = await prisma.contact.findMany({
      where: {
        organisationId,
        isDeleted: false,
        ownerId: { in: visibleUserIds }, // Only show contacts owned by visible users
        ...branchFilter, // Add branch filter
        OR: [
          { firstName: { contains: searchTerm, mode: 'insensitive' } },
          { lastName: { contains: searchTerm, mode: 'insensitive' } },
          { email: { contains: searchTerm, mode: 'insensitive' } },
          { jobTitle: { contains: searchTerm, mode: 'insensitive' } }
        ]
      },
      include: {
        account: { select: { name: true } },
        owner: { select: { firstName: true, lastName: true } }
      },
      take: Math.ceil(limit * 0.25) // 25% of results for contacts
    });

    contacts.forEach(contact => {
      results.push({
        id: contact.id,
        type: 'contact',
        title: `${contact.firstName} ${contact.lastName}`,
        subtitle: contact.account?.name || contact.jobTitle || 'No account',
        description: contact.email || 'No email',
        assignedTo: contact.owner ? `${contact.owner.firstName} ${contact.owner.lastName}` : undefined,
        createdAt: contact.createdAt,
        url: `/contacts/${contact.id}`
      });
    });

    // Search Accounts - filtered by hierarchy and branch
    const accounts = await prisma.account.findMany({
      where: {
        organisationId,
        isDeleted: false,
        ownerId: { in: visibleUserIds }, // Only show accounts owned by visible users
        ...branchFilter, // Add branch filter
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { industry: { contains: searchTerm, mode: 'insensitive' } },
          { website: { contains: searchTerm, mode: 'insensitive' } }
        ]
      },
      include: {
        owner: { select: { firstName: true, lastName: true } },
        _count: { select: { contacts: true, opportunities: true } }
      },
      take: Math.ceil(limit * 0.2) // 20% of results for accounts
    });

    accounts.forEach(account => {
      results.push({
        id: account.id,
        type: 'account',
        title: account.name,
        subtitle: account.industry || account.type || 'No industry',
        description: `${account._count.contacts} contacts • ${account._count.opportunities} opportunities`,
        value: account.annualRevenue || undefined,
        assignedTo: account.owner ? `${account.owner.firstName} ${account.owner.lastName}` : undefined,
        createdAt: account.createdAt,
        url: `/accounts/${account.id}`
      });
    });

    // Search Opportunities - filtered by hierarchy and branch
    const opportunities = await prisma.opportunity.findMany({
      where: {
        organisationId,
        isDeleted: false,
        ownerId: { in: visibleUserIds }, // Only show opportunities owned by visible users
        ...branchFilter, // Add branch filter
        OR: [
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { description: { contains: searchTerm, mode: 'insensitive' } },
          { leadSource: { contains: searchTerm, mode: 'insensitive' } }
        ]
      },
      include: {
        account: { select: { name: true } },
        owner: { select: { firstName: true, lastName: true } }
      },
      take: Math.ceil(limit * 0.1) // 10% of results for opportunities
    });

    opportunities.forEach(opportunity => {
      results.push({
        id: opportunity.id,
        type: 'opportunity',
        title: opportunity.name,
        subtitle: opportunity.account.name,
        description: `${opportunity.stage} • ${opportunity.probability}% probability`,
        status: opportunity.stage,
        value: opportunity.amount,
        assignedTo: opportunity.owner ? `${opportunity.owner.firstName} ${opportunity.owner.lastName}` : undefined,
        createdAt: opportunity.createdAt,
        url: `/opportunities/${opportunity.id}`
      });
    });

    // Search Tasks - filtered by hierarchy and branch
    const tasks = await prisma.task.findMany({
      where: {
        organisationId,
        isDeleted: false,
        assignedToId: { in: visibleUserIds }, // Only show tasks assigned to visible users
        ...branchFilter, // Add branch filter
        OR: [
          { subject: { contains: searchTerm, mode: 'insensitive' } },
          { description: { contains: searchTerm, mode: 'insensitive' } }
        ]
      },
      include: {
        assignedTo: { select: { firstName: true, lastName: true } },
        lead: { select: { firstName: true, lastName: true } },
        contact: { select: { firstName: true, lastName: true } },
        account: { select: { name: true } }
      },
      take: Math.ceil(limit * 0.05) // 5% of results for tasks
    });

    tasks.forEach(task => {
      let subtitle = 'Task';
      if (task.lead) subtitle = `Lead: ${task.lead.firstName} ${task.lead.lastName}`;
      else if (task.contact) subtitle = `Contact: ${task.contact.firstName} ${task.contact.lastName}`;
      else if (task.account) subtitle = `Account: ${task.account.name}`;

      results.push({
        id: task.id,
        type: 'task',
        title: task.subject,
        subtitle,
        description: `${task.status} • Priority: ${task.priority}`,
        status: task.status,
        assignedTo: task.assignedTo ? `${task.assignedTo.firstName} ${task.assignedTo.lastName}` : undefined,
        createdAt: task.createdAt,
        url: `/tasks/${task.id}`
      });
    });

    // Sort results by relevance (exact matches first, then by creation date)
    results.sort((a, b) => {
      const aExactMatch = a.title.toLowerCase().includes(searchTerm.toLowerCase());
      const bExactMatch = b.title.toLowerCase().includes(searchTerm.toLowerCase());

      if (aExactMatch && !bExactMatch) return -1;
      if (!aExactMatch && bExactMatch) return 1;

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Limit final results
    const finalResults = results.slice(0, limit);

    logger.info(`Global search completed: ${finalResults.length} results`, 'SEARCH', userId, organisationId || undefined, { query: searchTerm });

    // Save search history
    if (userId && searchTerm.length >= 2) {
      await prisma.searchHistory.create({
        data: {
          query: searchTerm,
          userId
        }
      }).catch(err => {
        logger.error('Failed to save search history', err, 'SEARCH_HISTORY', userId);
      });
    }

    return ResponseHandler.success(res, {
      results: finalResults,
      total: finalResults.length,
      query: searchTerm,
      searchTime: Date.now()
    }, 'Search completed successfully');

  } catch (error: any) {
    logger.apiError('GET', '/api/search/global', error, userId, organisationId || undefined);
    return ResponseHandler.serverError(res, 'An error occurred while searching');
  }
};

// GET /api/search/suggestions
export const searchSuggestions = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;
  const organisationId = getOrgId(user);
  const query = req.query.q as string;

  try {
    if (!organisationId) {
      return ResponseHandler.forbidden(res, 'User not associated with an organisation');
    }

    if (!query || query.trim().length < 1) {
      return ResponseHandler.success(res, { suggestions: [] }, 'No suggestions');
    }

    const searchTerm = query.trim();
    const suggestions: string[] = [];

    // Get visible user IDs based on hierarchy
    const visibleUserIds = await getVisibleUserIds(userId);

    // Get user's branch for additional filtering
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { branchId: true, role: true }
    });

    // Check if user is admin
    const userRole = await prisma.role.findFirst({
      where: {
        OR: [
          { id: currentUser?.role },
          { roleKey: currentUser?.role, organisationId: organisationId },
          { roleKey: currentUser?.role, organisationId: null }
        ]
      }
    });

    const isUserAdmin = userRole?.name === 'Admin' || userRole?.roleKey === 'admin';

    // Build branch filter
    const branchFilter = !isUserAdmin && currentUser?.branchId 
      ? { branchId: currentUser.branchId }
      : {};

    // Get suggestions from different entities - filtered by hierarchy and branch
    const [leadSuggestions, contactSuggestions, accountSuggestions] = await Promise.all([
      // Lead name suggestions
      prisma.lead.findMany({
        where: {
          organisationId,
          isDeleted: false,
          assignedToId: { in: visibleUserIds }, // Only show leads assigned to visible users
          ...branchFilter, // Add branch filter
          OR: [
            { firstName: { startsWith: searchTerm, mode: 'insensitive' } },
            { lastName: { startsWith: searchTerm, mode: 'insensitive' } },
            { company: { startsWith: searchTerm, mode: 'insensitive' } }
          ]
        },
        select: { firstName: true, lastName: true, company: true },
        take: 5
      }),

      // Contact name suggestions
      prisma.contact.findMany({
        where: {
          organisationId,
          ownerId: { in: visibleUserIds }, // Only show contacts owned by visible users
          ...branchFilter, // Add branch filter
          OR: [
            { firstName: { startsWith: searchTerm, mode: 'insensitive' } },
            { lastName: { startsWith: searchTerm, mode: 'insensitive' } }
          ]
        },
        select: { firstName: true, lastName: true },
        take: 3
      }),

      // Account name suggestions
      prisma.account.findMany({
        where: {
          organisationId,
          ownerId: { in: visibleUserIds }, // Only show accounts owned by visible users
          ...branchFilter, // Add branch filter
          name: { startsWith: searchTerm, mode: 'insensitive' }
        },
        select: { name: true },
        take: 3
      })
    ]);

    // Add lead suggestions
    leadSuggestions.forEach(lead => {
      const fullName = `${lead.firstName} ${lead.lastName}`;
      if (!suggestions.includes(fullName)) {
        suggestions.push(fullName);
      }
      if (lead.company && !suggestions.includes(lead.company)) {
        suggestions.push(lead.company);
      }
    });

    // Add contact suggestions
    contactSuggestions.forEach(contact => {
      const fullName = `${contact.firstName} ${contact.lastName}`;
      if (!suggestions.includes(fullName)) {
        suggestions.push(fullName);
      }
    });

    // Add account suggestions
    accountSuggestions.forEach(account => {
      if (!suggestions.includes(account.name)) {
        suggestions.push(account.name);
      }
    });

    return ResponseHandler.success(res, {
      suggestions: suggestions.slice(0, 10), // Limit to 10 suggestions
      query: searchTerm
    }, 'Suggestions retrieved successfully');

  } catch (error: any) {
    logger.apiError('GET', '/api/search/suggestions', error, userId, organisationId || undefined);
    return ResponseHandler.serverError(res, 'An error occurred while getting suggestions');
  }
};

// GET /api/search/recent
export const recentSearches = async (req: Request, res: Response) => {
  const user = (req as any).user;
  const userId = user?.id;

  try {
    const history = await prisma.searchHistory.groupBy({
      by: ['query'],
      where: {
        userId
      },
      _max: {
        createdAt: true
      },
      orderBy: {
        _max: {
          createdAt: 'desc'
        }
      },
      take: 10
    });

    const recent = history.map(h => h.query);

    return ResponseHandler.success(res, {
      recent,
      message: 'Recent searches retrieved'
    }, 'Recent searches retrieved');

  } catch (error: any) {
    logger.apiError('GET', '/api/search/recent', error, userId);
    return ResponseHandler.serverError(res, 'An error occurred while getting recent searches');
  }
};