import { handle } from "../lib/router.js";

export default {
  async fetch(request) {
    return handle(request);
  },
};
