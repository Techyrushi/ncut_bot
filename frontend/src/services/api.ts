import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api/v1',
  timeout: 15000,
  headers: { 'content-type': 'application/json' },
});

export function setApiToken(token?: string): void {
  if (token) api.defaults.headers.common.authorization = `Bearer ${token}`;
  else delete api.defaults.headers.common.authorization;
}

api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.error?.message;
      if (typeof message === 'string') error.message = message;
    }
    return Promise.reject(error);
  },
);
