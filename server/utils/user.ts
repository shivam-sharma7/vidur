import type { BasicProfile } from '~~/shared/types/profile-types';
import { userHandlesTable, usersTable, type User, type UserHandle } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { H3Event } from 'h3';
import { getToken } from './jwt';

export type OnboardingStatus = { onboardingURL: string | null };

export async function getUserOnboardStatus(event: H3Event): Promise<OnboardingStatus> {
  const config = useRuntimeConfig();
  const accessToken = await getToken(event);

  const res = await $fetch<OnboardingStatus>('/user/onboard', {
    baseURL: config.services.profileCity,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return res;
}

export async function getOrCreateUser(verifiedDetails: { email: string }, token: string): Promise<User | undefined> {
  if (IS_DEV) {
    console.log('getOrCreateUser called');
  }
  const db = await useDatabase();
  const config = useRuntimeConfig();

  const result = await db.select().from(usersTable).where(eq(usersTable.email, verifiedDetails.email));

  if (result && result.length > 0) {
    return result[0] as (typeof result)[number];
  }

  let userBasicProfile: BasicProfile | null = null;
  try {
    if (IS_DEV) {
      console.log('Calling userBasicProfile');
    }
    userBasicProfile = await $fetch<BasicProfile>('/user/basic-profile', {
      baseURL: config.services.profileCity,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    if (IS_DEV) {
      console.log(userBasicProfile);
    }
  } catch (e: any) {
    if (e.statusCode !== 401) console.error('Error fetching `basic-profile`', e);
    throw createError({
      statusCode: 401,
      statusMessage: 'Unable to use existing token, expired maybe',
    });
  }

  if (userBasicProfile == null) {
    throw createError({
      statusCode: 400,
      message: "Bad Request: Insufficient privilages to fetch user's information",
    });
  }

  const user = await db.transaction(async (tx) => {
    const top5SkillsCSV = userBasicProfile.resume?.top5Skills?.map((s: string) => s.trim()).join(',');

    const user = (
      await tx
        .insert(usersTable)
        .values({
          id: userBasicProfile.id,
          ...userBasicProfile.profile,
          top5SkillsCSV,
        })
        .returning()
    )[0];

    if (!user) throw new Error('User object not returned');

    const userId = user.id;
    const handles: UserHandle[] = Object.keys(userBasicProfile.handles).map((key) => {
      const value = userBasicProfile.handles[key];
      if (!value) throw new Error('Value of handle not found for key ' + key);
      return {
        key,
        value,
        userId,
      };
    });

    if (handles.length > 0) {
      await tx.insert(userHandlesTable).values(handles);
    }

    return user;
  });

  return user;
}
