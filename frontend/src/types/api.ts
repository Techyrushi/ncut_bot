export interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'SALES';
}

export interface Product {
  _id: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  imageUrl?: string;
  isActive: boolean;
  sizes: string[];
  grits: string[];
  colours: string[];
  backing: string[];
  specifications?: Record<string, unknown>;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface DashboardStats {
  totalCustomers: number;
  totalConversations: number;
  totalProductSelections: number;
  totalLeads: number;
  pendingLeads: number;
  humanHandovers: number;
}
