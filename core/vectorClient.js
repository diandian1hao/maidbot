const axios = require('axios');
const logger = require('../utils/logger');

const VECTOR_API = process.env.VECTOR_API_URL || 'http://127.0.0.1:8000';

/**
 * 向量客户端（兼容旧调用方式 + 新双库联动）
 * 注意：新的业务逻辑应使用 memoryRepository.search()
 * 此文件保留是为了兼容 index.js 中可能存在的旧调用
 */
module.exports = {
  /**
   * 全库搜索（不带用户过滤，仅用于调试/管理）
   * 生产环境请使用 memoryRepository.search(userId, query)
   */
  async search(query, topK = 3) {
    try {
      const res = await axios.post(`${VECTOR_API}/search`, {
        query,
        user_id: '__global__',  // 兼容旧接口，不会匹配到任何用户数据
        top_k: topK,
      }, { timeout: 10000 });
      return res.data.results || [];
    } catch (e) {
      logger.warn(`[VectorClient] 搜索失败: ${e.message}`);
      return [];
    }
  },

  /**
   * 健康检查
   */
  async health() {
    try {
      const res = await axios.get(`${VECTOR_API}/health`, { timeout: 5000 });
      return res.data;
    } catch {
      return { status: 'offline' };
    }
  }
};
