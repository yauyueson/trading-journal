export const TV_GRADES = ['S', 'A', 'B', 'C', 'D'] as const;
export type TVGrade = (typeof TV_GRADES)[number];

export const TV_GRADE_TO_SCORE: Record<string, number> = { S: 95, A: 80, B: 60, C: 40, D: 20 };

export function scoreToTVGrade(score: number | undefined | null): string {
    if (score == null) return '';
    if (score >= 90) return 'S';
    if (score >= 70) return 'A';
    if (score >= 50) return 'B';
    if (score >= 30) return 'C';
    return 'D';
}
