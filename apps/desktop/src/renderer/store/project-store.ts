import { create } from 'zustand';
import type { Project } from '../env.js';

interface ProjectState {
  projects: Project[];
  currentProjectId: string | null;
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (id: string) => void;
  setCurrentProject: (id: string | null) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  setProjects: (projects) => set({ projects }),
  addProject: (project) => set((s) => ({ projects: [project, ...s.projects] })),
  removeProject: (id) => set((s) => ({ projects: s.projects.filter((p) => p.id !== id) })),
  setCurrentProject: (currentProjectId) => set({ currentProjectId }),
}));
