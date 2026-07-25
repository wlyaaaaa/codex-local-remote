import type { ProjectSummary } from "@codex-local-remote/contracts";

export function registeredProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return projects.filter((project) => project.source === "registered");
}
