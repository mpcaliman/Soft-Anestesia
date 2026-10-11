export {};

declare global {
  namespace SoftAnesthesia {
    type UUID = string;
    type ISODate = string;
    type ISODateTime = string;
    type ModuleName =
      | 'dashboard' | 'pacientes' | 'agenda' | 'consulta' | 'pre' | 'termo'
      | 'prescricao' | 'documentos' | 'risco' | 'anestesia' | 'recuperacao'
      | 'financeiro' | 'orcamento' | 'doses' | 'ajustes';

    interface TabContext {
      readonly sessionId: string;
      readonly userId: UUID;
      readonly organizationId: UUID;
      readonly deviceId: string;
    }

    interface ModulePermission {
      readonly module: ModuleName;
      readonly canRead: boolean;
      readonly canWrite: boolean;
      readonly printOnly: boolean;
    }

    interface PatientIdentity {
      readonly nome: string;
      readonly nasc: ISODate | '';
      readonly cpf: string;
      readonly convenio: string;
      readonly prontuario: string;
      readonly telefone: string;
      readonly sexo: string;
      readonly patientKey?: string;
    }

    interface EncounterContext {
      readonly organizationId: UUID;
      readonly caseId: string;
      readonly caseKey?: string;
      readonly patientKey: string;
      readonly patientRef?: string;
      readonly sourceModule: ModuleName;
      readonly sourceRecordId: string;
    }

    interface CloudRecord<TData extends object> {
      readonly id: UUID;
      readonly organizationId: UUID;
      readonly createdBy: UUID;
      readonly version: number;
      readonly updatedAt: ISODateTime;
      readonly data: TData;
    }

    interface CloudMutation<TData extends object> {
      readonly organizationId: UUID;
      readonly userId: UUID;
      readonly module: ModuleName;
      readonly recordId: UUID;
      readonly expectedVersion: number;
      readonly operationId: UUID;
      readonly checksum: string;
      readonly payload: TData;
      readonly queuedAt: ISODateTime;
    }

    interface CloudReceipt {
      readonly organizationId: UUID;
      readonly recordId: UUID;
      readonly operationId: UUID;
      readonly checksum: string;
      readonly serverVersion: number;
      readonly acceptedAt: ISODateTime;
    }

    interface OfflineEnvelope {
      readonly ownerKey: string;
      readonly organizationId: UUID;
      readonly userId: UUID;
      readonly operationId: UUID;
      readonly ciphertext: string;
      readonly iv: string;
      readonly keyVersion: number;
      readonly retryCount: number;
      readonly nextAttemptAt: ISODateTime | null;
    }

    interface RealtimeChange<TData extends object> {
      readonly organizationId: UUID;
      readonly module: ModuleName;
      readonly recordId: UUID;
      readonly serverVersion: number;
      readonly payload: TData;
    }

    interface PreservedConflict<TData extends object> {
      readonly organizationId: UUID;
      readonly recordId: UUID;
      readonly baseVersion: number;
      readonly local: TData;
      readonly remote: TData;
      readonly detectedAt: ISODateTime;
    }

    interface SignatureProvider {
      readonly id: string;
      readonly label: string;
      readonly type: 'external' | 'cloud';
      isAvailable(): boolean;
      listCertificates(): Promise<readonly string[]>;
      getCertificateInfo(credentialId: string): Promise<object | null>;
      sign(context: object): Promise<object>;
      status(): string;
    }

    interface SafeTelemetryEvent {
      readonly name: string;
      readonly appVersion: string;
      readonly durationMs?: number;
      readonly success?: boolean;
      readonly errorCode?: string;
      readonly occurredAt: ISODateTime;
    }
  }

  interface Window {
    SoftEncounterIdentity: {
      normalizeName(value: unknown): string;
      digits(value: unknown): string;
      isoDate(value: unknown): SoftAnesthesia.ISODate | null;
      validCpf(value: unknown): boolean;
      fromRecord(value: object): SoftAnesthesia.PatientIdentity;
      legacyPatientKey(value: SoftAnesthesia.PatientIdentity): string | null;
      strongPatientKey(value: SoftAnesthesia.PatientIdentity): string | null;
      procedureText(value: object): string;
      legacyEncounterKey(patientKey: string, value: object): string | null;
      strongEncounterKey(identity: SoftAnesthesia.PatientIdentity, value: object): string | null;
      scopedKey(organizationId: UUID, key: string): string | null;
    };
    SoftQR: {
      generate(text: string, errorCorrection?: 'L' | 'M' | 'Q' | 'H'): {
        size: number;
        modules: boolean[][];
      };
      svg(text: string, options?: { ecl?: 'L' | 'M' | 'Q' | 'H'; quiet?: number; px?: number }): string;
    };
    assinaturaDigital: object;
  }
}
