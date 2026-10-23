import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    locale?: string;
    // When the password last changed (#397): the session's password version (auth.ts jwt callback)
    passwordChangedAt?: Date | null;
  }

  interface Session {
    user: {
      id: string;
      locale?: string;
    } & DefaultSession['user'];
    // The password version the session signed in under (#397), checked again by protectedProcedure
    passwordStamp?: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    locale?: string;
    passwordStamp?: number;
  }
}
