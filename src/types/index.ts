export interface User {
    id: string;
    name: string;
    email: string;
  }
  
  export interface AppError extends Error {
    statusCode: number;
    status: string;
  }