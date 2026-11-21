const MAX_CAUSE_DEPTH = 5;

function matchesUniqueMarker(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (/unique/i.test(message) || /duplicate/i.test(message)) return true;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	return code === "P2002" || code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

/** Database drivers and ORMs wrap the constraint violation at different depths of `cause`. */
export function isUniqueConstraintError(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (matchesUniqueMarker(current)) return true;
		if (!current || typeof current !== "object" || !("cause" in current)) return false;
		current = current.cause;
	}
	return false;
}
