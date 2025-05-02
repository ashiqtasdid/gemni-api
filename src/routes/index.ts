import express, { Router } from 'express';
import apiRoutes from './apiRoutes';

const router: Router = express.Router();

// Register all route modules with their base paths
router.use('/fix', apiRoutes.fixRoutes);
router.use('/create', apiRoutes.createRoutes);

export default router;