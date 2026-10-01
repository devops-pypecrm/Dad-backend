import express from 'express';
import { getTrendInsight } from '../controllers/aiInsightController';
import {
    getDashboardStats,
    getSalesChartData,
    getTopLeads,
    getSalesForecast,
    getLeadSourceAnalytics,
    getAiInsights,
    getTopPerformers,
    getSalesBook,
    getUserWiseSales,
    getLeadsByStage,
    getLeadCampaigns,
    getCallActivityTrend,
    getTaskFollowUpCompletion,
    getOpportunityPipelineValue,
    getBranchPerformance,
    getUserTrendsSummary,
    getUserDealRanking,
    getLeadHealth,
    getExpectedRevenueReport
} from '../controllers/analyticsController';
import { protect } from '../middleware/authMiddleware';

const router = express.Router();

router.get('/dashboard', protect, getDashboardStats);
router.get('/sales-chart', protect, getSalesChartData);
router.get('/top-leads', protect, getTopLeads);
router.get('/forecast', protect, getSalesForecast);
router.get('/expected-revenue', protect, getExpectedRevenueReport);
router.get('/lead-sources', protect, getLeadSourceAnalytics);
router.get('/insights', protect, getAiInsights);
router.get('/top-performers', protect, getTopPerformers);
router.get('/sales-book', protect, getSalesBook);
router.get('/user-sales', protect, getUserWiseSales);
router.get('/overview', protect, getDashboardStats); // Alias for reports page
router.get('/leads-by-stage', protect, getLeadsByStage);
router.get('/lead-campaigns', protect, getLeadCampaigns);
router.get('/call-activity-trend', protect, getCallActivityTrend);
router.get('/task-followup-completion', protect, getTaskFollowUpCompletion);
router.get('/opportunity-pipeline-value', protect, getOpportunityPipelineValue);
router.get('/branch-performance', protect, getBranchPerformance);
router.get('/user-trends-summary', protect, getUserTrendsSummary);
router.get('/user-deal-ranking', protect, getUserDealRanking);
router.get('/lead-health', protect, getLeadHealth);
router.get('/ai-insight', protect, getTrendInsight);

export default router;
