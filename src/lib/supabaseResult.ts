type SupabaseMaybeError = {
    error?: { message?: string } | Error | null;
};

export function throwIfSupabaseError<T extends SupabaseMaybeError>(result: T): T {
    if (result.error) throw result.error;
    return result;
}

export function requireSupabaseData<T>(
    result: SupabaseMaybeError & { data?: T | null },
    message: string,
): T {
    throwIfSupabaseError(result);
    if (result.data == null) throw new Error(message);
    if (Array.isArray(result.data) && result.data.length === 0) throw new Error(message);
    return result.data;
}
