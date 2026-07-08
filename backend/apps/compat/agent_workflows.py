from __future__ import annotations

from dataclasses import dataclass


SCHEMA_VERSION = "a3.agent-workflow.v1"


@dataclass(frozen=True)
class AgentWorkflowContract:
    workflow: str
    title: str
    goal: str
    required_steps: tuple[str, ...]
    target_steps: tuple[str, ...]
    state_updates: tuple[str, ...]
    fallback_strategy: str
    research_basis: tuple[str, ...]
    product_pattern: tuple[str, ...]
    input_schema: dict
    output_schema: dict
    quality_metrics: tuple[dict, ...]

    def as_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "workflow": self.workflow,
            "title": self.title,
            "goal": self.goal,
            "requiredSteps": list(self.required_steps),
            "targetSteps": list(self.target_steps),
            "stateUpdates": list(self.state_updates),
            "fallbackStrategy": self.fallback_strategy,
            "researchBasis": list(self.research_basis),
            "productPattern": list(self.product_pattern),
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "qualityMetrics": list(self.quality_metrics),
        }


WORKFLOW_CONTRACTS: tuple[AgentWorkflowContract, ...] = (
    AgentWorkflowContract(
        workflow="profile_extract",
        title="Profile extraction",
        goal="Extract structured learner profile signals from user input.",
        required_steps=("SafetyAgent", "ProfileAgent", "MemoryAgent"),
        target_steps=("LearnerModelAgent", "ConsentAuditAgent"),
        state_updates=("LearnerProfile",),
        fallback_strategy="Keep existing profile and ask the learner to complete required fields.",
        research_basis=("Generative Agents memory stream", "DSPy module contract"),
        product_pattern=("iFlytek diagnostic profiling", "Xueersi unified learner companion"),
        input_schema={
            "type": "object",
            "properties": {"text": {"type": "string"}, "privacyConsent": {"type": "boolean"}},
            "required": ["text"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "profile": {
                    "type": "object",
                    "properties": {
                        "grade": {"type": "string"},
                        "majorDirection": {"type": "string"},
                        "foundationLevel": {"type": "string"},
                        "dailyMinutes": {"type": "number"},
                        "learningGoals": {"type": "array"},
                        "weakPoints": {"type": "array"},
                        "expectedResources": {"type": "array"},
                    },
                },
                "updatedFields": {"type": "array"},
                "traceId": {"type": "string"},
            },
            "required": ["profile"],
        },
        quality_metrics=(
            {"key": "profileCompleteness", "target": ">=0.8"},
            {"key": "privacyGateRespected", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="profile_setup",
        title="Structured profile setup",
        goal="Persist structured learner profile choices, refresh the path, and generate a study plan with traceable agent evidence.",
        required_steps=("ProfileNormalizeAgent", "ProfileCommitAgent", "PlannerAgent", "StudyPlanAgent"),
        target_steps=("ConsentAuditAgent", "LearnerModelAgent"),
        state_updates=("LearnerProfile", "LearningPath", "StudyPlan", "AgentRun"),
        fallback_strategy="Reject invalid profile choices before persistence; keep previous path and plan if generation fails.",
        research_basis=("Open learner modeling", "Learning path planning", "DSPy module contract"),
        product_pattern=("Liulishuo profile-to-plan onboarding", "iFlytek diagnosis-plan loop"),
        input_schema={
            "type": "object",
            "properties": {
                "grade": {"type": "string"},
                "majorDirection": {"type": "string"},
                "foundationLevel": {"type": "string"},
                "dailyStudyTime": {"type": "string"},
                "learningGoals": {"type": "array"},
                "weakPoints": {"type": "array"},
                "expectedResources": {"type": "array"},
            },
            "required": ["grade", "majorDirection", "foundationLevel", "dailyStudyTime"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "profile": {"type": "object"},
                "pathGenerated": {"type": "boolean"},
                "studyPlanGenerated": {"type": "boolean"},
                "studyPlan": {"type": "object"},
            },
            "required": ["profile", "pathGenerated", "studyPlanGenerated"],
        },
        quality_metrics=(
            {"key": "profileCommitted", "target": "true"},
            {"key": "pathGenerated", "target": "true"},
            {"key": "studyPlanGenerated", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="profile_interview",
        title="Conversational learner profile interview",
        goal="Build and confirm a learner profile through multi-turn natural-language interview, then refresh path and study plan.",
        required_steps=("SafetyAgent", "ProfileInterviewAgent", "LearnerModelAgent", "MemoryCommitAgent", "PlannerAgent"),
        target_steps=("ConsentAuditAgent", "MotivationAgent"),
        state_updates=("LearnerProfile", "LearningPath", "StudyPlan", "AgentRun"),
        fallback_strategy="Ask one or two missing plan-critical fields when the profile is incomplete; do not commit until confirmed.",
        research_basis=("Open learner modeling", "Generative Agents memory stream", "Socratic tutoring dialogue"),
        product_pattern=("Liulishuo onboarding interview", "Khanmigo guided learner setup"),
        input_schema={
            "type": "object",
            "properties": {
                "message": {"type": "string"},
                "action": {"type": "string", "enum": ["message", "confirm"]},
            },
            "required": [],
        },
        output_schema={
            "type": "object",
            "properties": {
                "profile": {"type": "object"},
                "profileReadiness": {
                    "type": "object",
                    "properties": {
                        "dimensionCount": {"type": "integer"},
                        "status": {"type": "string"},
                        "missingDimensions": {"type": "array"},
                    },
                },
                "interviewSession": {
                    "type": "object",
                    "properties": {
                        "turnCount": {"type": "integer"},
                        "interviewComplete": {"type": "boolean"},
                        "profileCommitted": {"type": "boolean"},
                    },
                },
                "profileCommitted": {"type": "boolean"},
                "generated": {"type": "object"},
                "traceId": {"type": "string"},
            },
            "required": ["profile", "profileReadiness", "interviewSession"],
        },
        quality_metrics=(
            {"key": "profileCompleteness", "target": ">=8 dimensions"},
            {"key": "followUpFocused", "target": "<=2 fields"},
            {"key": "profileCommitted", "target": "true after confirm"},
            {"key": "pathAndPlanRefreshed", "target": "true after confirm"},
        ),
    ),
    AgentWorkflowContract(
        workflow="path_generate",
        title="Learning path generation",
        goal="Generate an explainable path from profile, weak points, and course graph.",
        required_steps=("LearningStateAgent", "PlannerAgent", "GraphAgent", "StudyPlanAgent"),
        target_steps=("CurriculumGraphAgent",),
        state_updates=("LearningPath", "LearningPathItem"),
        fallback_strategy="Use default course order when graph constraints are unavailable.",
        research_basis=("LATS planning search", "ProgPrompt planning DSL", "DSPy module contract"),
        product_pattern=("iFlytek diagnosis-plan-recommend loop", "Xiaoyuan knowledge graph loop"),
        input_schema={
            "type": "object",
            "properties": {"courseId": {"type": "string"}, "force": {"type": "boolean"}},
            "required": [],
        },
        output_schema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "status": {"type": "string"},
                                    "estimatedMinutes": {"type": "number"},
                                    "knowledgePoint": {
                                        "type": "object",
                                        "properties": {
                                            "title": {"type": "string"},
                                            "difficulty": {"type": "number"},
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                "studyPlan": {
                    "type": "object",
                    "properties": {
                        "durationDays": {"type": "integer"},
                        "dailyMinutes": {"type": "number"},
                        "days": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "day": {"type": "integer"},
                                    "tasks": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "title": {"type": "string"},
                                                "estimatedMinutes": {"type": "number"},
                                                "completed": {"type": "boolean"},
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                "traceId": {"type": "string"},
            },
            "required": ["path"],
        },
        quality_metrics=(
            {"key": "prerequisiteCoverage", "target": ">=0.9"},
            {"key": "weakPointAlignment", "target": ">=0.8"},
        ),
    ),
    AgentWorkflowContract(
        workflow="teacher_task_execute",
        title="Teacher intervention dispatch",
        goal="Validate teacher scope, dispatch student notifications, and expose a student-facing follow-up action.",
        required_steps=("TeacherWorkbenchAgent", "NotificationAgent", "StudentFollowupAgent"),
        target_steps=("RiskTriageAgent", "ParentNotificationAgent"),
        state_updates=("UserNotification", "AgentRun"),
        fallback_strategy="Reject out-of-scope targets and do not create notifications when validation fails.",
        research_basis=("Human-in-the-loop tutoring", "Learning analytics early warning"),
        product_pattern=("Xueersi teacher dashboard", "iFlytek class intervention loop"),
        input_schema={
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "studentId": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["type"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "teacherTaskResult": {
                    "type": "object",
                    "properties": {
                        "taskType": {"type": "string"},
                        "createdNotifications": {"type": "integer"},
                        "title": {"type": "string"},
                    },
                },
                "studentFollowup": {
                    "type": "object",
                    "properties": {
                        "actionUrl": {"type": "string"},
                        "createdNotifications": {"type": "integer"},
                    },
                },
            },
            "required": ["teacherTaskResult"],
        },
        quality_metrics=(
            {"key": "teacherScopeResolved", "target": "true"},
            {"key": "notificationWritten", "target": "true"},
            {"key": "studentCanResume", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="admission_diagnostic",
        title="Admission diagnostic loop",
        goal="Score entry diagnostic, update learner profile, refresh path, and generate an executable study plan.",
        required_steps=("DiagnosticAgent", "ProfileUpdateAgent", "PlannerAgent", "StudyPlanAgent"),
        target_steps=("DiagnosticItemAgent", "MasteryEstimatorAgent"),
        state_updates=("LearnerProfile", "LearningPath", "StudyPlan", "AgentRun"),
        fallback_strategy="Keep previous path and ask the learner to retry diagnostic when scoring or refresh fails.",
        research_basis=("Bayesian knowledge tracing", "Cognitive diagnosis model", "DSPy module contract"),
        product_pattern=("Liulishuo placement test", "iFlytek diagnosis-plan loop"),
        input_schema={
            "type": "object",
            "properties": {
                "answers": {"type": "array"},
                "goal": {"type": "string"},
                "durationDays": {"type": "integer"},
                "dailyMinutes": {"type": "integer"},
            },
            "required": ["answers"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "diagnostic": {
                    "type": "object",
                    "properties": {
                        "score": {"type": "number"},
                        "level": {"type": "object"},
                        "weakPoints": {"type": "array"},
                        "nextAction": {"type": "string"},
                    },
                },
                "path": {"type": "object"},
                "plan": {
                    "type": "object",
                    "properties": {
                        "durationDays": {"type": "integer"},
                        "dailyMinutes": {"type": "number"},
                        "days": {"type": "array"},
                    },
                },
                "traceId": {"type": "string"},
            },
            "required": ["diagnostic", "path", "plan"],
        },
        quality_metrics=(
            {"key": "levelAssigned", "target": "true"},
            {"key": "profileWriteBack", "target": "true"},
            {"key": "planCreatedFromDiagnostic", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="recommend",
        title="Personalized resource recommendation",
        goal="Rank grounded learning resources using profile, path, weak points, and KB evidence.",
        required_steps=("LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"),
        target_steps=("ReviewSchedulerAgent", "TeacherInterventionAgent"),
        state_updates=("RecommendationLog", "UserFavorite"),
        fallback_strategy="Use lexical retrieval and mark fallback evidence when vector search is unavailable.",
        research_basis=("Self-RAG grounded generation", "Gorilla tool schema", "DSPy module contract"),
        product_pattern=("Quizlet notes-to-study-resources", "NotebookLM source-grounded generation"),
        input_schema={
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "topK": {"type": "integer"},
                "mode": {"type": "string", "enum": ["fast", "deep"]},
            },
            "required": [],
        },
        output_schema={
            "type": "object",
            "properties": {
                "recommendations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "score": {"type": "number"},
                            "reason": {"type": "string"},
                        },
                    },
                },
                "sources": {"type": "array"},
                "resourcePack": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "resources": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "href": {"type": "string"},
                                },
                            },
                        },
                    },
                },
                "traceId": {"type": "string"},
            },
            "required": ["recommendations", "sources"],
        },
        quality_metrics=(
            {"key": "citationCoverage", "target": ">=0.9"},
            {"key": "profileMatchCoverage", "target": ">=0.8"},
            {"key": "fallbackTransparency", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="resource_generate",
        title="Personalized multimodal resource generation",
        goal="Generate a grounded seven-type resource pack through retriever, pedagogy, synthesis, practice, verifier, and commit agents.",
        required_steps=("RetrieverAgent", "PedagogyAgent", "ResourceSynthesisAgent", "PracticeGenerationAgent", "VerifierAgent", "ResourcePackCommitAgent"),
        target_steps=("OpenMAICClassroomAgent", "VideoGenerationAgent"),
        state_updates=("LearnerProfile", "ResourcePackLog", "AgentRun"),
        fallback_strategy="Use current goal as fallback evidence and mark degraded retrieval when the local knowledge base is unavailable.",
        research_basis=("Self-RAG grounded generation", "Multi-agent task decomposition", "DSPy module contract"),
        product_pattern=("NotebookLM source-grounded study guide", "Quizlet notes-to-practice resources"),
        input_schema={
            "type": "object",
            "properties": {
                "goal": {"type": "string"},
                "topK": {"type": "integer"},
            },
            "required": [],
        },
        output_schema={
            "type": "object",
            "properties": {
                "resourcePack": {
                    "type": "object",
                    "properties": {
                        "schemaVersion": {"type": "string"},
                        "resourcePackId": {"type": "string"},
                        "goal": {"type": "string"},
                        "resources": {"type": "array"},
                        "resourceVerification": {"type": "object"},
                        "practiceReadiness": {"type": "object"},
                    },
                },
                "resourcePackId": {"type": "string"},
                "traceId": {"type": "string"},
            },
            "required": ["resourcePack", "resourcePackId", "traceId"],
        },
        quality_metrics=(
            {"key": "requiredResourceTypes", "target": ">=7"},
            {"key": "codeLabIncluded", "target": "true"},
            {"key": "citationCoverage", "target": ">=0.9"},
            {"key": "resourcePackCommitted", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="material_knowledge_graph",
        title="Uploaded material knowledge graph extraction",
        goal="Convert parsed multimodal knowledge-base blocks into source-bound entities, relations, and claims.",
        required_steps=("GraphInputAgent", "GraphExtractionAgent", "LLMGraphExtractionAgent", "GraphPersistenceAgent"),
        target_steps=("GraphVerifierAgent",),
        state_updates=("KnowledgeGraphEntity", "KnowledgeGraphRelation", "KnowledgeGraphClaim", "AgentRun"),
        fallback_strategy="Use deterministic rule extraction and mark graph output as degraded when LLM extraction is unavailable.",
        research_basis=("LightRAG entity-relation extraction", "Microsoft GraphRAG text-unit graph extraction", "RAG-Anything multimodal graph"),
        product_pattern=("NotebookLM source-grounded artifact graph", "A3 local knowledge-base evidence graph"),
        input_schema={
            "type": "object",
            "properties": {
                "resourceId": {"type": "string"},
                "resourceTitle": {"type": "string"},
            },
            "required": ["resourceId"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "materialGraph": {
                    "type": "object",
                    "properties": {
                        "schemaVersion": {"type": "string"},
                        "status": {"type": "string"},
                        "entityCount": {"type": "integer"},
                        "relationCount": {"type": "integer"},
                        "claimCount": {"type": "integer"},
                        "degraded": {"type": "boolean"},
                        "reason": {"type": "string"},
                    },
                },
                "traceId": {"type": "string"},
            },
            "required": ["materialGraph", "traceId"],
        },
        quality_metrics=(
            {"key": "sourceEvidenceRequired", "target": "true"},
            {"key": "schemaVersionPresent", "target": "true"},
            {"key": "degradationTransparent", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="resource_feedback",
        title="Resource feedback adaptive planning",
        goal="Convert resource usage feedback into learning-effect evidence and write the resulting strategy back to the study plan.",
        required_steps=("ResourceFeedbackAgent", "LearningEffectAgent", "StudyPlanAgent", "MemoryCommitAgent"),
        target_steps=("MotivationAgent", "TeacherInterventionAgent"),
        state_updates=("LearnerProfile", "StudyPlan", "LearningEffectReport", "AgentRun"),
        fallback_strategy="Persist feedback and keep the current plan when plan adjustment cannot be applied.",
        research_basis=("Generative Agents memory reflection", "Learning analytics closed-loop adaptation", "DSPy module contract"),
        product_pattern=("Liulishuo daily feedback-to-plan loop", "Quizlet practice feedback loop"),
        input_schema={
            "type": "object",
            "properties": {
                "packId": {"type": "string"},
                "action": {"type": "string", "enum": ["opened", "completed", "skipped", "favorited"]},
                "resourceType": {"type": "string"},
                "score": {"type": "number"},
            },
            "required": ["packId", "action"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "feedback": {"type": "object"},
                "effectReport": {
                    "type": "object",
                    "properties": {
                        "resourceUsage": {"type": "object"},
                        "planAdjustment": {"type": "object"},
                    },
                },
                "traceId": {"type": "string"},
            },
            "required": ["feedback", "effectReport", "traceId"],
        },
        quality_metrics=(
            {"key": "feedbackPersisted", "target": "true"},
            {"key": "learningEffectEvaluated", "target": "true"},
            {"key": "studyPlanAdjusted", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="openmaic_classroom_bridge",
        title="OpenMAIC classroom artifact writeback",
        goal="Receive OpenMAIC classroom job evidence and attach it to the A3 resource pack audit trail.",
        required_steps=("A3ResourceBridgeAgent", "ResourcePackCommitAgent"),
        target_steps=("VerifierAgent",),
        state_updates=("LearnerProfile", "ResourcePackLog", "OpenMAICArtifact", "AgentRun"),
        fallback_strategy="Persist failed/degraded artifact status instead of marking classroom generation as succeeded.",
        research_basis=("Toolformer tool-use trace", "Enterprise workflow audit log"),
        product_pattern=("NotebookLM source artifact audit", "OpenMAIC classroom handoff"),
        input_schema={"type": "object", "properties": {"packId": {"type": "string"}, "jobId": {"type": "string"}, "status": {"type": "string"}}, "required": ["packId", "jobId"]},
        output_schema={"type": "object", "properties": {"artifact": {"type": "object"}, "resourcePack": {"type": "object"}, "traceId": {"type": "string"}}, "required": ["artifact", "resourcePack", "traceId"]},
        quality_metrics=(
            {"key": "artifactPersisted", "target": "true"},
            {"key": "statusTransparent", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="openmaic_video_bridge",
        title="OpenMAIC video artifact writeback",
        goal="Receive video provider success or degradation evidence and attach it to the A3 resource pack.",
        required_steps=("A3VideoBridgeAgent", "ResourcePackCommitAgent"),
        target_steps=("VerifierAgent",),
        state_updates=("LearnerProfile", "ResourcePackLog", "OpenMAICArtifact", "AgentRun"),
        fallback_strategy="Write failed/degraded provider evidence when no playable video URL is available.",
        research_basis=("Toolformer tool-use trace", "Enterprise workflow audit log"),
        product_pattern=("OpenMAIC video provider writeback", "A3 multimodal artifact audit"),
        input_schema={"type": "object", "properties": {"packId": {"type": "string"}, "provider": {"type": "string"}, "status": {"type": "string"}}, "required": ["packId", "provider", "status"]},
        output_schema={"type": "object", "properties": {"artifact": {"type": "object"}, "resourcePack": {"type": "object"}, "traceId": {"type": "string"}}, "required": ["artifact", "resourcePack", "traceId"]},
        quality_metrics=(
            {"key": "providerEvidenceRecorded", "target": "true"},
            {"key": "degradationTransparent", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="openmaic_pptx_export_bridge",
        title="OpenMAIC PPTX export artifact writeback",
        goal="Receive front-end PPTX export evidence and attach it to the A3 resource pack audit trail.",
        required_steps=("A3PPTXExportBridgeAgent", "ResourcePackCommitAgent"),
        target_steps=("VerifierAgent",),
        state_updates=("LearnerProfile", "ResourcePackLog", "OpenMAICArtifact", "AgentRun"),
        fallback_strategy="Write export failure status and reason when PPTX export fails.",
        research_basis=("Toolformer tool-use trace", "Enterprise workflow audit log"),
        product_pattern=("OpenMAIC PPTX handoff", "A3 artifact history"),
        input_schema={"type": "object", "properties": {"packId": {"type": "string"}, "jobId": {"type": "string"}, "status": {"type": "string"}}, "required": ["packId", "jobId"]},
        output_schema={"type": "object", "properties": {"artifact": {"type": "object"}, "resourcePack": {"type": "object"}, "traceId": {"type": "string"}}, "required": ["artifact", "resourcePack", "traceId"]},
        quality_metrics=(
            {"key": "exportEvidenceRecorded", "target": "true"},
            {"key": "artifactHistoryUpdated", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="openmaic_interaction_bridge",
        title="OpenMAIC classroom interaction writeback",
        goal="Convert OpenMAIC classroom interactions into A3 learner events for progress and report feedback.",
        required_steps=("A3OpenMAICInteractionBridgeAgent", "ProfileAgent"),
        target_steps=("LearningEffectAgent",),
        state_updates=("LearnerProfile", "AgentRun"),
        fallback_strategy="Reject malformed interaction payloads before writing learner events.",
        research_basis=("Learning analytics event stream", "Enterprise workflow audit log"),
        product_pattern=("Liulishuo behavior event feedback", "OpenMAIC classroom interaction handoff"),
        input_schema={"type": "object", "properties": {"packId": {"type": "string"}, "classroomId": {"type": "string"}, "classroomJobId": {"type": "string"}, "actionType": {"type": "string"}}, "required": ["packId", "classroomId", "classroomJobId", "actionType"]},
        output_schema={"type": "object", "properties": {"interaction": {"type": "object"}, "traceId": {"type": "string"}}, "required": ["interaction", "traceId"]},
        quality_metrics=(
            {"key": "learningEventWritten", "target": "true"},
            {"key": "interactionTraceable", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="qa_interact",
        title="Grounded tutoring interaction",
        goal="Answer classroom questions with learner state, path context, citations, and verification.",
        required_steps=("SafetyAgent", "RetrieverAgent", "TeacherAgent", "VerifierAgent", "FollowUpAgent"),
        target_steps=("TutorOrchestrationAgent", "LearningNoteAgent"),
        state_updates=("AgentRun", "LearningNote"),
        fallback_strategy="Provide learning-method guidance only when evidence is missing.",
        research_basis=("ReAct thought-action-observation loop", "Self-RAG claim verification"),
        product_pattern=("Khanmigo guided tutoring", "Photomath step-by-step explanation"),
        input_schema={
            "type": "object",
            "properties": {"question": {"type": "string"}, "context": {"type": "object"}},
            "required": ["question"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "answer": {"type": "string"},
                "citations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "location": {"type": "string"},
                            "score": {"type": "number"},
                            "snippet": {"type": "string"},
                        },
                    },
                },
                "verified": {"type": "boolean"},
                "followUps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "question": {"type": "string"},
                            "type": {"type": "string"},
                            "reason": {"type": "string"},
                        },
                    },
                },
            },
            "required": ["verified"],
        },
        quality_metrics=(
            {"key": "guidedBeforeAnswer", "target": "true"},
            {"key": "verifiedCoverage", "target": ">=0.9"},
            {"key": "followUpCoverage", "target": ">=2 per answer"},
        ),
    ),
    AgentWorkflowContract(
        workflow="verify_answer",
        title="Answer verification",
        goal="Classify safety risks and verify claims against provided citations.",
        required_steps=("SafetyAgent", "ClaimExtractorAgent", "VerifierAgent"),
        target_steps=(),
        state_updates=("VerificationLog",),
        fallback_strategy="Return verified=false when evidence is missing or uncertain.",
        research_basis=("Self-RAG critique", "ReAct observation validation"),
        product_pattern=("NotebookLM source grounding", "Khanmigo safety boundary"),
        input_schema={
            "type": "object",
            "properties": {"question": {"type": "string"}, "answer": {"type": "string"}, "sources": {"type": "array"}},
            "required": ["question", "answer"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "verified": {"type": "boolean"},
                "citations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "location": {"type": "string"},
                            "score": {"type": "number"},
                            "snippet": {"type": "string"},
                        },
                    },
                },
                "claims": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string"},
                            "verified": {"type": "boolean"},
                            "evidence": {"type": "string"},
                        },
                    },
                },
                "safety": {
                    "type": "object",
                    "properties": {
                        "safe": {"type": "boolean"},
                        "category": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                },
            },
            "required": ["verified", "safety"],
        },
        quality_metrics=(
            {"key": "missingEvidenceRefusalRate", "target": "100%"},
            {"key": "safetyRefusalRate", "target": ">=0.95"},
        ),
    ),
    AgentWorkflowContract(
        workflow="question_bank_generate",
        title="Evidence-grounded question bank generation",
        goal="Generate candidate questions from indexed knowledge-base evidence, verify their quality, and route them into teacher review before formal use.",
        required_steps=("QuestionGeneratorAgent", "QuestionVerifierAgent"),
        target_steps=("TeacherReviewAgent", "ItemDifficultyAgent"),
        state_updates=("QuestionGenerationJob", "Question", "QuestionQualityCheck", "AgentRun"),
        fallback_strategy="Fail the generation job without creating fake questions when model keys, evidence, or validation are unavailable.",
        research_basis=("Retrieval-augmented item generation", "LLM-as-judge verification", "Human-in-the-loop assessment QA"),
        product_pattern=("Quizlet notes-to-practice generation", "Khan Academy teacher-reviewed item banks"),
        input_schema={
            "type": "object",
            "properties": {
                "job": {"type": "object"},
                "resourceId": {"type": "string"},
                "knowledgePointId": {"type": "string"},
                "count": {"type": "integer"},
                "scope": {"type": "string"},
            },
            "required": ["job"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "questionGenerationJob": {
                    "type": "object",
                    "properties": {
                        "status": {"type": "string"},
                        "requestedCount": {"type": "integer"},
                        "generatedCount": {"type": "integer"},
                        "verifiedCount": {"type": "integer"},
                        "rejectedCount": {"type": "integer"},
                    },
                },
                "questionVerification": {
                    "type": "object",
                    "properties": {
                        "questionCount": {"type": "integer"},
                        "qualityCheckCount": {"type": "integer"},
                        "passed": {"type": "integer"},
                    },
                },
            },
            "required": ["questionGenerationJob", "questionVerification"],
        },
        quality_metrics=(
            {"key": "noFakeQuestions", "target": "true"},
            {"key": "generatedQuestionsHaveEvidence", "target": "100%"},
            {"key": "teacherReviewRequired", "target": "true"},
        ),
    ),
    AgentWorkflowContract(
        workflow="assess_grade",
        title="Assessment grading loop",
        goal="Grade answers, write wrong questions, update weak points, and refresh plans.",
        required_steps=("AdaptivePracticeAgent", "AssessmentAgent", "ProfileUpdateAgent", "ReviewSchedulerAgent", "StudyPlanAgent"),
        target_steps=("ReportAgent", "TeacherInterventionAgent"),
        state_updates=("AssessmentSession", "WrongQuestion", "LearnerProfile", "StudyPlan"),
        fallback_strategy="Mark uncertain grading for review and keep previous plan if refresh fails.",
        research_basis=("Reflexion verbal feedback", "Generative Agents memory reflection"),
        product_pattern=("Photomath step feedback", "iFlytek wrong-question remediation"),
        input_schema={
            "type": "object",
            "properties": {"sessionId": {"type": "string"}, "selectedAnswer": {"type": "string"}, "skipped": {"type": "boolean"}},
            "required": ["sessionId"],
        },
        output_schema={
            "type": "object",
            "properties": {
                "session": {
                    "type": "object",
                    "properties": {
                        "status": {"type": "string"},
                        "score": {"type": "number"},
                    },
                },
                "isCorrect": {"type": "boolean"},
                "profileUpdate": {
                    "type": "object",
                    "properties": {
                        "weakPoints": {"type": "array"},
                        "extraProfile": {"type": "object"},
                    },
                },
                "studyPlan": {"type": "object"},
            },
            "required": ["session", "isCorrect"],
        },
        quality_metrics=(
            {"key": "wrongQuestionWriteBack", "target": "true"},
            {"key": "weakPointSync", "target": "true"},
            {"key": "planRefreshOnError", "target": "true"},
        ),
    ),
)

_CONTRACT_BY_WORKFLOW = {contract.workflow: contract for contract in WORKFLOW_CONTRACTS}


def describe_agent_workflows() -> list[dict]:
    return [contract.as_dict() for contract in WORKFLOW_CONTRACTS]


def get_agent_workflow_contract(workflow: str) -> AgentWorkflowContract | None:
    return _CONTRACT_BY_WORKFLOW.get(str(workflow or "").strip())


def evaluate_trace_contract(trace: dict) -> dict:
    workflow = str(trace.get("workflow") or "").strip()
    contract = get_agent_workflow_contract(workflow)
    steps = trace.get("steps") if isinstance(trace.get("steps"), list) else []
    step_names = [str(step.get("name") or "").strip() for step in steps if isinstance(step, dict)]
    completed_steps = {
        str(step.get("name") or "").strip()
        for step in steps
        if isinstance(step, dict) and str(step.get("status") or "completed") in {"completed", "degraded"}
    }

    if contract is None:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "workflow": workflow,
            "known": False,
            "ready": False,
            "requiredSteps": [],
            "targetSteps": [],
            "presentRequiredSteps": [],
            "missingRequiredSteps": [],
            "unknownSteps": [name for name in step_names if name],
            "latestTraceId": trace.get("traceId"),
            "status": trace.get("status", "unknown"),
        }

    required_steps = list(contract.required_steps)
    target_steps = list(contract.target_steps)
    known_steps = set(required_steps + target_steps + ["OrchestratorAgent", "MemoryCommitAgent"])
    present_required = [name for name in required_steps if name in completed_steps]
    missing_required = [name for name in required_steps if name not in completed_steps]
    unknown_steps = [name for name in step_names if name and name not in known_steps]
    return {
        **contract.as_dict(),
        "known": True,
        "ready": not missing_required and str(trace.get("status") or "") == "completed",
        "presentRequiredSteps": present_required,
        "missingRequiredSteps": missing_required,
        "unknownSteps": unknown_steps,
        "latestTraceId": trace.get("traceId"),
        "latestStatus": trace.get("status", "unknown"),
        "latestFallbackStrategy": trace.get("fallbackStrategy", "none"),
        "latestLatencyMs": trace.get("latencyMs", 0),
    }


def summarize_workflow_readiness(agent_runs: list[dict]) -> list[dict]:
    latest_by_workflow: dict[str, dict] = {}
    for trace in agent_runs:
        workflow = str(trace.get("workflow") or "").strip()
        if workflow and workflow not in latest_by_workflow:
            latest_by_workflow[workflow] = trace

    summaries: list[dict] = []
    for contract in WORKFLOW_CONTRACTS:
        trace = latest_by_workflow.get(contract.workflow)
        if trace is None:
            summaries.append({
                **contract.as_dict(),
                "known": True,
                "ready": False,
                "presentRequiredSteps": [],
                "missingRequiredSteps": list(contract.required_steps),
                "unknownSteps": [],
                "latestTraceId": None,
                "latestStatus": "missing",
                "latestFallbackStrategy": "none",
                "latestLatencyMs": 0,
            })
        else:
            summaries.append(evaluate_trace_contract(trace))
    return summaries
