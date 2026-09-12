import { getHealthStatus } from "$lib/health";

export default {
  async health(c) {
    const status = getHealthStatus();
    const httpStatus = status.healthy ? 200 : 503;
    return c.json(status, httpStatus);
  },
};
