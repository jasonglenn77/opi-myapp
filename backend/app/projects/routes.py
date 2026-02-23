from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from app.auth import get_current_user
from .service import (
    list_assignable_projects,
    get_assignment_bundle,
    save_project_assignment,
    list_project_events,
)

router = APIRouter(prefix="/api", tags=["projects"])

class AssignmentSaveRequest(BaseModel):
    qbo_customer_id: int
    status: str
    start_date: Optional[str] = None   # "YYYY-MM-DD"
    end_date: Optional[str] = None     # "YYYY-MM-DD"
    project_manager_ids: List[int] = []
    primary_project_manager_id: Optional[int] = None
    work_crew_ids: List[int] = []
    primary_work_crew_id: Optional[int] = None

@router.get("/assignment/projects")
def assignment_projects(user=Depends(get_current_user)):
    # List QBO projects for the dropdown/search
    return list_assignable_projects()

@router.get("/assignment/bundle")
def assignment_bundle(qbo_customer_id: int, user=Depends(get_current_user)):
    # Loads:
    # - project meta (start/end/status)
    # - active PM assignments
    # - active crew assignments
    # - list of all PMs
    # - list of all crews
    return get_assignment_bundle(qbo_customer_id=qbo_customer_id)

@router.post("/assignment/save")
def assignment_save(req: AssignmentSaveRequest, user=Depends(get_current_user)):
    try:
        return save_project_assignment(req=req, actor_user_id=int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/projects/{qbo_customer_id}/events")
def project_events(qbo_customer_id: int, user=Depends(get_current_user)):
    return list_project_events(qbo_customer_id=qbo_customer_id)