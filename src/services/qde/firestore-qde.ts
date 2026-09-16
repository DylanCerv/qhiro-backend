import { randomUUID } from 'node:crypto';
import admin from 'firebase-admin';
import type {
  QdeCostCatalog,
  QdeDefaultConfig,
  QdeEnergyConfig,
  QdePlanVersion,
  QdeProfileRecord,
  QdeProject,
  QdeVersionInputs,
  QdeVersionOutput,
  QdeVersionStatus,
} from '../../types/qde.js';
import { defaultCostCatalog, defaultEnergyConfig, montePlataPreset } from './engine.js';

function firestore() {
  if (!admin.apps.length) return null;
  return admin.firestore();
}

const memoryStore: {
  projects: Record<string, QdeProject>;
  versions: Record<string, QdePlanVersion>;
  profiles: Record<string, QdeProfileRecord>;
} = {
  projects: {},
  versions: {},
  profiles: {},
};

const QDE_PROJECTS = 'qde_projects';
const QDE_VERSIONS = 'versions';
const QDE_PROFILES = 'qde_profiles';
const QDE_SETTINGS = 'qde_settings';
const DEFAULT_COSTS_DOC = 'default_costs';
const DEFAULT_CONFIG_DOC = 'default_config';

const memoryDefaultCosts: QdeCostCatalog = defaultCostCatalog();
const memoryDefaultConfig: QdeDefaultConfig = {
  costs: defaultCostCatalog(),
  energy: defaultEnergyConfig(),
};

function versionCollection(projectId: string) {
  const fs = firestore();
  if (!fs) return null;
  return fs.collection(QDE_PROJECTS).doc(projectId).collection(QDE_VERSIONS);
}

function memVersionKey(projectId: string, versionId: string): string {
  return `${projectId}/${versionId}`;
}

export async function seedQdeProfiles(): Promise<void> {
  const fs = firestore();
  const preset = montePlataPreset();
  const profiles: QdeProfileRecord[] = [
    {
      ...preset.sprayProfile,
      type: 'spray_a',
      evidence: 'Prototype Rig — perfil A V0',
      createdAt: new Date().toISOString(),
    },
    {
      profileId: 'spray_b_v0',
      label: 'Perfil B — V0',
      version: '0.1.0',
      type: 'spray_b',
      ra: 10,
      fo: 0.25,
      pa: 3.2,
      qa: 1.8,
      evidence: 'Prototype Rig — perfil B V0',
      createdAt: new Date().toISOString(),
    },
  ];

  for (const profile of profiles) {
    if (!fs) {
      memoryStore.profiles[profile.profileId] = profile;
      continue;
    }
    await fs.collection(QDE_PROFILES).doc(profile.profileId).set(profile, { merge: true });
  }
}

export async function seedDefaultCosts(): Promise<void> {
  await seedDefaultConfig();
}

export async function seedDefaultConfig(): Promise<void> {
  const config = {
    costs: defaultCostCatalog(),
    energy: defaultEnergyConfig(),
    updatedAt: new Date().toISOString(),
  };
  const fs = firestore();
  if (!fs) {
    Object.assign(memoryDefaultConfig, config);
    Object.assign(memoryDefaultCosts, config.costs);
    return;
  }
  await fs.collection(QDE_SETTINGS).doc(DEFAULT_CONFIG_DOC).set(config, { merge: true });
  await fs
    .collection(QDE_SETTINGS)
    .doc(DEFAULT_COSTS_DOC)
    .set({ ...config.costs, updatedAt: config.updatedAt }, { merge: true });
}

export async function getDefaultConfig(): Promise<QdeDefaultConfig> {
  const fs = firestore();
  if (!fs) {
    return {
      costs: { ...memoryDefaultConfig.costs },
      energy: { ...memoryDefaultConfig.energy },
      updatedAt: memoryDefaultConfig.updatedAt,
    };
  }

  const configSnap = await fs.collection(QDE_SETTINGS).doc(DEFAULT_CONFIG_DOC).get();
  if (configSnap.exists) {
    const data = configSnap.data() as Partial<QdeDefaultConfig>;
    return {
      costs: { ...defaultCostCatalog(), ...data.costs },
      energy: { ...defaultEnergyConfig(), ...data.energy },
      updatedAt: data.updatedAt,
    };
  }

  const costsSnap = await fs.collection(QDE_SETTINGS).doc(DEFAULT_COSTS_DOC).get();
  const legacyCosts = costsSnap.exists
    ? { ...defaultCostCatalog(), ...(costsSnap.data() as QdeCostCatalog) }
    : defaultCostCatalog();

  return {
    costs: legacyCosts,
    energy: defaultEnergyConfig(legacyCosts ? 12 : 12),
    updatedAt: costsSnap.exists ? (costsSnap.data()?.updatedAt as string) : undefined,
  };
}

export async function saveDefaultConfig(config: QdeDefaultConfig): Promise<QdeDefaultConfig> {
  const fs = firestore();
  const normalized: QdeDefaultConfig = {
    costs: { ...defaultCostCatalog(), ...config.costs },
    energy: { ...defaultEnergyConfig(config.energy?.peonEffectiveRadiusM), ...config.energy },
    updatedAt: new Date().toISOString(),
  };

  if (!fs) {
    Object.assign(memoryDefaultConfig, normalized);
    Object.assign(memoryDefaultCosts, normalized.costs);
    return normalized;
  }

  await fs.collection(QDE_SETTINGS).doc(DEFAULT_CONFIG_DOC).set(normalized);
  await fs
    .collection(QDE_SETTINGS)
    .doc(DEFAULT_COSTS_DOC)
    .set({ ...normalized.costs, updatedAt: normalized.updatedAt });
  return normalized;
}

export async function getDefaultCosts(): Promise<QdeCostCatalog> {
  const config = await getDefaultConfig();
  return config.costs;
}

export async function saveDefaultCosts(costs: QdeCostCatalog): Promise<QdeCostCatalog> {
  const current = await getDefaultConfig();
  const saved = await saveDefaultConfig({ ...current, costs });
  return saved.costs;
}

export async function getQdeProfiles(): Promise<QdeProfileRecord[]> {
  const fs = firestore();
  if (!fs) return Object.values(memoryStore.profiles);
  const snap = await fs.collection(QDE_PROFILES).get();
  return snap.docs.map((doc) => doc.data() as QdeProfileRecord);
}

export async function getQdeProjects(userId: string): Promise<QdeProject[]> {
  const fs = firestore();
  if (!fs) {
    return Object.values(memoryStore.projects)
      .filter((project) => project.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const snap = await fs.collection(QDE_PROJECTS).where('userId', '==', userId).get();
  return snap.docs
    .map((doc) => doc.data() as QdeProject)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getQdeProject(userId: string, projectId: string): Promise<QdeProject | null> {
  const fs = firestore();
  if (!fs) {
    const project = memoryStore.projects[projectId];
    return project?.userId === userId ? project : null;
  }

  const snap = await fs.collection(QDE_PROJECTS).doc(projectId).get();
  if (!snap.exists) return null;
  const project = snap.data() as QdeProject;
  return project.userId === userId ? project : null;
}

export async function createQdeProject(input: {
  userId: string;
  name: string;
  description?: string;
  clientUserId?: string;
  clientName?: string;
  parcelId?: string;
  parcelName?: string;
}): Promise<QdeProject> {
  const now = new Date().toISOString();
  const project: QdeProject = {
    projectId: randomUUID(),
    userId: input.userId,
    clientUserId: input.clientUserId,
    clientName: input.clientName,
    parcelId: input.parcelId,
    parcelName: input.parcelName,
    name: input.name,
    description: input.description,
    status: 'draft',
    currentVersionNumber: 0,
    createdAt: now,
    updatedAt: now,
  };

  const fs = firestore();
  if (!fs) {
    memoryStore.projects[project.projectId] = project;
    return project;
  }

  await fs.collection(QDE_PROJECTS).doc(project.projectId).set(project);
  return project;
}

export async function updateQdeProject(
  userId: string,
  projectId: string,
  patch: Partial<
    Pick<QdeProject, 'name' | 'description' | 'status' | 'parcelId' | 'clientUserId' | 'clientName' | 'parcelName'>
  >,
): Promise<QdeProject | null> {
  const existing = await getQdeProject(userId, projectId);
  if (!existing) return null;

  const updated: QdeProject = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  const fs = firestore();
  if (!fs) {
    memoryStore.projects[projectId] = updated;
    return updated;
  }

  await fs.collection(QDE_PROJECTS).doc(projectId).set(updated, { merge: true });
  return updated;
}

export async function deleteQdeProject(userId: string, projectId: string): Promise<boolean> {
  const existing = await getQdeProject(userId, projectId);
  if (!existing) return false;

  const fs = firestore();
  if (!fs) {
    delete memoryStore.projects[projectId];
    for (const key of Object.keys(memoryStore.versions)) {
      if (key.startsWith(`${projectId}/`)) delete memoryStore.versions[key];
    }
    return true;
  }

  const versionsSnap = await versionCollection(projectId)!.get();
  const batch = fs.batch();
  versionsSnap.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(fs.collection(QDE_PROJECTS).doc(projectId));
  await batch.commit();
  return true;
}

export async function getQdeVersions(userId: string, projectId: string): Promise<QdePlanVersion[]> {
  const project = await getQdeProject(userId, projectId);
  if (!project) return [];

  const fs = firestore();
  if (!fs) {
    return Object.values(memoryStore.versions)
      .filter((version) => version.projectId === projectId && version.userId === userId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  const snap = await versionCollection(projectId)!.orderBy('versionNumber', 'desc').get();
  return snap.docs.map((doc) => doc.data() as QdePlanVersion);
}

export async function getQdeVersion(
  userId: string,
  projectId: string,
  versionId: string,
): Promise<QdePlanVersion | null> {
  const project = await getQdeProject(userId, projectId);
  if (!project) return null;

  const fs = firestore();
  if (!fs) {
    const version = memoryStore.versions[memVersionKey(projectId, versionId)];
    return version?.userId === userId ? version : null;
  }

  const snap = await versionCollection(projectId)!.doc(versionId).get();
  if (!snap.exists) return null;
  const version = snap.data() as QdePlanVersion;
  return version.userId === userId ? version : null;
}

export async function createQdeVersion(input: {
  userId: string;
  projectId: string;
  label: string;
  inputs: QdeVersionInputs;
  parentVersionId?: string;
}): Promise<QdePlanVersion | null> {
  const project = await getQdeProject(input.userId, input.projectId);
  if (!project) return null;

  const now = new Date().toISOString();
  const versionNumber = project.currentVersionNumber + 1;
  const version: QdePlanVersion = {
    versionId: randomUUID(),
    projectId: input.projectId,
    userId: input.userId,
    versionNumber,
    label: input.label,
    status: 'draft',
    parentVersionId: input.parentVersionId,
    inputs: input.inputs,
    createdAt: now,
    updatedAt: now,
    createdBy: input.userId,
  };

  const fs = firestore();
  if (!fs) {
    memoryStore.versions[memVersionKey(input.projectId, version.versionId)] = version;
    memoryStore.projects[input.projectId] = {
      ...project,
      currentVersionNumber: versionNumber,
      latestVersionId: version.versionId,
      updatedAt: now,
    };
    return version;
  }

  const batch = fs.batch();
  batch.set(versionCollection(input.projectId)!.doc(version.versionId), version);
  batch.set(
    fs.collection(QDE_PROJECTS).doc(input.projectId),
    {
      currentVersionNumber: versionNumber,
      latestVersionId: version.versionId,
      updatedAt: now,
    },
    { merge: true },
  );
  await batch.commit();
  return version;
}

export async function updateQdeVersionInputs(
  userId: string,
  projectId: string,
  versionId: string,
  inputs: QdeVersionInputs,
): Promise<QdePlanVersion | null> {
  const version = await getQdeVersion(userId, projectId, versionId);
  if (!version) return null;

  const updated: QdePlanVersion = {
    ...version,
    inputs,
    output: undefined,
    status: 'draft',
    updatedAt: new Date().toISOString(),
  };

  const fs = firestore();
  if (!fs) {
    memoryStore.versions[memVersionKey(projectId, versionId)] = updated;
    return updated;
  }

  await versionCollection(projectId)!.doc(versionId).set(updated, { merge: true });
  return updated;
}

export async function saveQdeVersionOutput(
  userId: string,
  projectId: string,
  versionId: string,
  output: QdeVersionOutput,
): Promise<QdePlanVersion | null> {
  const version = await getQdeVersion(userId, projectId, versionId);
  if (!version) return null;

  const updated: QdePlanVersion = {
    ...version,
    output,
    status: output.selectedAlternative ? 'computed' : 'draft',
    updatedAt: new Date().toISOString(),
  };

  const fs = firestore();
  if (!fs) {
    memoryStore.versions[memVersionKey(projectId, versionId)] = updated;
    return updated;
  }

  await versionCollection(projectId)!.doc(versionId).set(updated, { merge: true });
  await fs.collection(QDE_PROJECTS).doc(projectId).set({ updatedAt: updated.updatedAt }, { merge: true });
  return updated;
}

export async function markQdeVersionSelected(
  userId: string,
  projectId: string,
  versionId: string,
): Promise<QdePlanVersion | null> {
  const versions = await getQdeVersions(userId, projectId);
  const fs = firestore();

  for (const version of versions) {
    const nextStatus: QdeVersionStatus =
      version.versionId === versionId && version.output?.selectedAlternative
        ? 'selected'
        : version.status === 'selected'
          ? 'superseded'
          : version.status;

    if (nextStatus === version.status) continue;

    const updated = { ...version, status: nextStatus, updatedAt: new Date().toISOString() };
    if (!fs) {
      memoryStore.versions[memVersionKey(projectId, version.versionId)] = updated;
    } else {
      await versionCollection(projectId)!.doc(version.versionId).set(
        { status: nextStatus, updatedAt: updated.updatedAt },
        { merge: true },
      );
    }
  }

  if (fs) {
    await fs.collection(QDE_PROJECTS).doc(projectId).set(
      {
        status: 'active',
        latestVersionId: versionId,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  } else {
    const project = memoryStore.projects[projectId];
    if (project) {
      memoryStore.projects[projectId] = {
        ...project,
        status: 'active',
        latestVersionId: versionId,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return getQdeVersion(userId, projectId, versionId);
}
