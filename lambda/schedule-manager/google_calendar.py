"""
Google Calendar Integration Module

This module handles authentication and fetching events from Google Calendar.
Uses the REST API directly to avoid heavy dependencies.
"""

import os
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Any
import logging

logger = logging.getLogger()


class GoogleCalendarClient:
    """Client for interacting with Google Calendar API using REST"""
    
    BASE_URL = "https://www.googleapis.com/calendar/v3"
    
    def __init__(self, calendar_id: str, api_key: str = None):
        """
        Initialize Google Calendar client
        
        Args:
            calendar_id: The Google Calendar ID
            api_key: Google API key (for public calendars)
        """
        self.calendar_id = calendar_id
        self.api_key = api_key or os.environ.get('GOOGLE_API_KEY')
        
        if not self.api_key:
            logger.error('No API key provided for Google Calendar')
            raise ValueError('Google API key is required')
    
    
    def fetch_upcoming_events(self, days_ahead: int = 7) -> List[Dict[str, Any]]:
        """
        Fetch upcoming calendar events using REST API
        
        Args:
            days_ahead: Number of days to fetch events for
            
        Returns:
            List of calendar events
        """
        try:
            now = datetime.utcnow().isoformat() + 'Z'
            end_time = (datetime.utcnow() + timedelta(days=days_ahead)).isoformat() + 'Z'
            
            url = f"{self.BASE_URL}/calendars/{self.calendar_id}/events"
            params = {
                'key': self.api_key,
                'timeMin': now,
                'timeMax': end_time,
                'singleEvents': 'true',
                'orderBy': 'startTime',
                'maxResults': 50
            }
            
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            events = data.get('items', [])
            logger.info(f'Fetched {len(events)} events from calendar')
            
            return events
            
        except requests.exceptions.RequestException as e:
            logger.error(f'Error fetching calendar events: {str(e)}')
            if hasattr(e, 'response') and e.response is not None:
                logger.error(f'Response: {e.response.text}')
            return []
    
    def parse_event_to_show(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Parse Google Calendar event to show format
        
        Args:
            event: Google Calendar event object
            
        Returns:
            Show data dictionary for DynamoDB
        """
        event_id = event.get('id', '')
        summary = event.get('summary', 'Untitled Show')
        description = event.get('description', '')
        
        # Parse start/end times
        start = event.get('start', {})
        end = event.get('end', {})
        
        start_time = start.get('dateTime', start.get('date', ''))
        end_time = end.get('dateTime', end.get('date', ''))
        
        # Extract show information
        show_data = {
            'showId': generate_show_id(summary),
            'showName': summary,
            'description': description,
            'calendarEventId': event_id,
            'startTime': start_time,
            'endTime': end_time,
            'duration': calculate_duration(start_time, end_time),
            'recurring': event.get('recurrence') is not None,
            'lastUpdated': datetime.utcnow().isoformat() + 'Z'
        }
        
        return show_data


def generate_show_id(show_name: str) -> str:
    """
    Generate a unique show ID from show name
    
    Args:
        show_name: The show name
        
    Returns:
        URL-friendly show ID
    """
    import re
    # Convert to lowercase and replace spaces with hyphens
    show_id = show_name.lower()
    show_id = re.sub(r'[^a-z0-9]+', '-', show_id)
    show_id = show_id.strip('-')
    return show_id


def calculate_duration(start_time: str, end_time: str) -> int:
    """
    Calculate duration in seconds between two ISO timestamps
    
    Args:
        start_time: Start time (ISO format)
        end_time: End time (ISO format)
        
    Returns:
        Duration in seconds
    """
    try:
        start = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
        end = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
        return int((end - start).total_seconds())
    except Exception as e:
        logger.error(f'Error calculating duration: {str(e)}')
        return 0
