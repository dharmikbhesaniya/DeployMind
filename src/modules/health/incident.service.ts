import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';

export interface IncidentRecord {
  id: string;
  serviceId?: string;
  deploymentId?: string;
  symptom: string;
  diagnosis: string;
  actionTaken?: string;
  riskLevel: 'SAFE' | 'OPERATOR_APPROVAL_REQUIRED';
  resolved: boolean;
  createdAt: number;
  resolvedAt?: number;
}

export class IncidentService {
  // Records an incident when an anomaly or crash is detected
  async recordIncident(params: {
    serviceId?: string;
    deploymentId?: string;
    symptom: string;
    diagnosis: string;
    riskLevel?: 'SAFE' | 'OPERATOR_APPROVAL_REQUIRED';
    actionTaken?: string;
  }): Promise<IncidentRecord> {
    const id = `inc_${crypto.randomUUID()}`;
    const riskLevel = params.riskLevel || 'SAFE';

    await db.insert(schema.incidents).values({
      id,
      serviceId: params.serviceId,
      deploymentId: params.deploymentId,
      symptom: params.symptom,
      diagnosis: params.diagnosis,
      actionTaken: params.actionTaken,
      riskLevel,
      resolved: false,
      createdAt: Date.now(),
    });

    // Also record in audit log
    await db.insert(schema.auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      eventType: 'incident_detected',
      serviceId: params.serviceId,
      details: JSON.stringify({
        incidentId: id,
        symptom: params.symptom,
        diagnosis: params.diagnosis,
        riskLevel,
      }),
      timestamp: Date.now(),
    });

    return {
      id,
      serviceId: params.serviceId,
      deploymentId: params.deploymentId,
      symptom: params.symptom,
      diagnosis: params.diagnosis,
      actionTaken: params.actionTaken,
      riskLevel,
      resolved: false,
      createdAt: Date.now(),
    };
  }

  // Resolves an existing incident
  async resolveIncident(incidentId: string, actionTaken: string): Promise<void> {
    await db
      .update(schema.incidents)
      .set({
        actionTaken,
        resolved: true,
        resolvedAt: Date.now(),
      })
      .where(eq(schema.incidents.id, incidentId));

    await db.insert(schema.auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      eventType: 'incident_resolved',
      details: JSON.stringify({ incidentId, actionTaken }),
      timestamp: Date.now(),
    });
  }

  // Returns all unresolved incidents
  async getActiveIncidents(): Promise<any[]> {
    return db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.resolved, false));
  }
}

export const incidentService = new IncidentService();
